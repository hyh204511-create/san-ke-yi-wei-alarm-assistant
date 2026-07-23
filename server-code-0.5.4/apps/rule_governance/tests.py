import json
import base64
import struct

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from apps.governance.models import AssistantProfile, EnterpriseGrant, EnterpriseScope, RoleAssignment
from apps.governance.services import assign_role

from .models import RulePackage, RuleReviewEvent
from .services import RuleGovernanceError, create_draft, publish_package, review_package, rollback_to_package, submit_for_review, update_draft
from .validation import RulePayloadValidationError, payload_hash, validate_rule_payload
from apps.response_governance.services import create_draft as create_response_asset, publish_asset, review_asset, submit_for_review as submit_response_asset


def valid_payload(alarm_name="抽烟报警"):
    return {
        "schemaVersion": 2,
        "version": "placeholder",
        "rules": [{
            "id": "rule-smoking",
            "enabled": True,
            "priority": 100,
            "match": {"alarmNames": [alarm_name], "sourceKinds": ["REALTIME"]},
            "handlingMode": "AUTO",
            "channels": [{"type": "TEXT", "order": 1, "templateId": "text-smoking-v1", "recipientType": "DRIVER_TERMINAL", "terminalTts": True}],
            "channelStrategy": "SINGLE",
            "retryPolicy": {"maxRetries": 2, "delaysMs": [5000, 10000], "retryOn": ["FAILED"], "maxDurationMs": 30000},
            "fallback": "MANUAL",
        }],
    }


def pcm_wav_base64():
    sample_rate = 8000
    pcm = b"\x00\x00" * 800
    fmt = struct.pack("<HHIIHH", 1, 1, sample_rate, sample_rate * 2, 2, 16)
    raw = b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(pcm)) + b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(pcm)) + pcm
    return base64.b64encode(raw).decode("ascii")


class RuleGovernanceTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.configurer = user_model.objects.create_user(username="rule-configurer")
        self.reviewer = user_model.objects.create_user(username="rule-reviewer")
        self.monitor = user_model.objects.create_user(username="rule-runtime-monitor")
        AssistantProfile.objects.create(user=self.configurer, display_name="规则配置员", employee_code="RULE-CFG")
        AssistantProfile.objects.create(user=self.reviewer, display_name="规则审核员", employee_code="RULE-REV")
        AssistantProfile.objects.create(user=self.monitor, display_name="监控值班员", employee_code="MONITOR-01")
        self.enterprise = EnterpriseScope.objects.create(code="COMPANY-001", name="测试运输企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        for user in [self.configurer, self.reviewer, self.monitor]:
            EnterpriseGrant.objects.create(user=user, enterprise=self.enterprise)
        assign_role(user=self.configurer, role=RoleAssignment.Role.RULE_CONFIGURER, assigned_by=self.configurer)
        assign_role(user=self.reviewer, role=RoleAssignment.Role.RULE_REVIEWER, assigned_by=self.reviewer)
        assign_role(user=self.monitor, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.monitor)
        self.enterprise_scope_ids = [str(self.enterprise.public_id)]
        text_asset = create_response_asset(
            actor=self.configurer, asset_key="text-smoking-v1", version="v1", channel_type="TEXT", enterprise_scope_ids=self.enterprise_scope_ids,
            change_note="测试固定文本", text_template="{vehicleNo} 发生 {alarmName}，请立即安全处置。",
        )
        submit_response_asset(actor=self.configurer, asset=text_asset)
        review_asset(actor=self.reviewer, asset=text_asset, approved=True, comment="测试话术已审核")
        publish_asset(actor=self.reviewer, asset=text_asset)

    def test_schema_v2_requires_channel_recipient_and_template(self):
        payload = valid_payload()
        validate_rule_payload(payload)
        invalid = valid_payload()
        invalid["rules"][0]["channels"][0].pop("recipientType")
        with self.assertRaises(RulePayloadValidationError):
            validate_rule_payload(invalid)

    def test_multi_channel_rule_requires_explicit_strategy_and_realtime_source(self):
        payload = valid_payload()
        payload["rules"][0]["channels"].append({
            "type": "VOICE", "order": 2, "assetId": "audio-smoking-v1", "recipientType": "DRIVER_TERMINAL",
            "spokenTemplate": "驾驶员，平台已报警，请不要吸烟，注意行车安全。",
        })
        with self.assertRaises(RulePayloadValidationError):
            validate_rule_payload(payload)
        payload["rules"][0]["channelStrategy"] = "FALLBACK"
        with self.assertRaises(RulePayloadValidationError):
            validate_rule_payload(payload)
        payload["rules"][0]["match"]["sourceKinds"] = ["PREWARNING"]
        with self.assertRaises(RulePayloadValidationError):
            validate_rule_payload(payload)

    def test_explicit_voice_required_text_fallback_policy_is_valid(self):
        payload = valid_payload("驾驶员突发情况报警")
        payload["rules"][0].update({
            "reminderPolicy": {
                "category": "DRIVER_IMMEDIATE",
                "driverReminder": "VOICE_REQUIRED",
                "secondaryChannelMode": "ON_PRIMARY_FAILURE",
                "completion": {
                    "source": "PLATFORM_STATUS",
                    "fields": ["alarmStatus", "alarmCompleteStatus"],
                    "clearedValues": {"alarmStatus": ["0", "CLEARED"], "alarmCompleteStatus": ["6", "已解除"]},
                    "unknownAction": "MANUAL_REVIEW",
                },
            },
            "channels": [
                {"type": "VOICE", "order": 1, "assetId": "audio-emergency-v1", "recipientType": "DRIVER_TERMINAL", "spokenTemplate": "请立即安全停车"},
                {"type": "TEXT", "order": 2, "templateId": "text-smoking-v1", "recipientType": "DRIVER_TERMINAL", "terminalTts": True},
            ],
            "channelStrategy": "FALLBACK",
        })
        validate_rule_payload(payload)

    def test_published_speeding_prewarning_can_use_reviewed_voice_then_text_flow(self):
        payload = valid_payload("超速驾驶")
        payload["rules"][0].update({
            "match": {"sourceKinds": ["PREWARNING"], "alarmNames": ["超速驾驶"]},
            "allowRealIntercom": True,
            "reminderPolicy": {
                "category": "DRIVER_IMMEDIATE",
                "driverReminder": "VOICE_REQUIRED",
                "secondaryChannelMode": "AFTER_PRIMARY_SUCCESS",
                "completion": {"source": "MANUAL_CONFIRMATION", "fields": [], "clearedValues": {}, "unknownAction": "MANUAL_REVIEW"},
            },
            "channels": [
                {"type": "VOICE", "order": 1, "assetId": "voice-speeding-v1", "recipientType": "DRIVER_TERMINAL", "spokenTemplate": "驾驶员，平台已报警，车辆超速驾驶，请降速安全行驶。"},
                {"type": "TEXT", "order": 2, "templateId": "text-speeding-v1", "recipientType": "DRIVER_TERMINAL", "terminalTts": True},
            ],
            "channelStrategy": "SEQUENTIAL",
            "fallback": "TEXT_ON_VOICE_FAILURE",
        })
        validate_rule_payload(payload)

    def test_configure_review_publish_flow_is_separated_and_immutable(self):
        draft = create_draft(actor=self.configurer, version="rules-v2.0.0", payload=valid_payload(), change_note="加入文本优先策略", enterprise_scope_ids=self.enterprise_scope_ids)
        update_draft(actor=self.configurer, package=draft, payload=valid_payload("接打手持电话报警"), change_note="调整报警类型")
        submitted = submit_for_review(actor=self.configurer, package=draft)
        self.assertEqual(submitted.status, RulePackage.Status.IN_REVIEW)
        with self.assertRaises(RuleGovernanceError):
            update_draft(actor=self.configurer, package=draft, payload=valid_payload())
        with self.assertRaises(RuleGovernanceError) as caught:
            review_package(actor=self.configurer, package=draft, approved=True, comment="本人批准")
        self.assertEqual(caught.exception.code, "PERMISSION_DENIED")
        approved = review_package(actor=self.reviewer, package=draft, approved=True, comment="规则与模板边界确认")
        published = publish_package(actor=self.reviewer, package=approved)
        self.assertEqual(published.status, RulePackage.Status.PUBLISHED)
        self.assertEqual(published.content_hash, payload_hash(published.payload))
        self.assertEqual(RuleReviewEvent.objects.filter(rule_package=published).count(), 5)

    def test_reviewer_cannot_approve_own_draft_even_with_both_roles(self):
        RoleAssignment.objects.create(user=self.reviewer, role=RoleAssignment.Role.RULE_CONFIGURER, assigned_by=self.reviewer)
        draft = create_draft(actor=self.reviewer, version="rules-reviewer-own", payload=valid_payload(), change_note="自建草稿", enterprise_scope_ids=self.enterprise_scope_ids)
        submit_for_review(actor=self.reviewer, package=draft)
        with self.assertRaises(RuleGovernanceError) as caught:
            review_package(actor=self.reviewer, package=draft, approved=True, comment="自审")
        self.assertEqual(caught.exception.code, "REVIEWER_SEPARATION_VIOLATION")

    def test_new_publish_retires_previous_and_rollback_creates_new_version(self):
        first = create_draft(actor=self.configurer, version="rules-first", payload=valid_payload(), change_note="首版", enterprise_scope_ids=self.enterprise_scope_ids)
        submit_for_review(actor=self.configurer, package=first)
        review_package(actor=self.reviewer, package=first, approved=True, comment="批准首版")
        publish_package(actor=self.reviewer, package=first)
        second = create_draft(actor=self.configurer, version="rules-second", payload=valid_payload("疲劳驾驶报警"), change_note="第二版", enterprise_scope_ids=self.enterprise_scope_ids, based_on=first)
        submit_for_review(actor=self.configurer, package=second)
        review_package(actor=self.reviewer, package=second, approved=True, comment="批准第二版")
        publish_package(actor=self.reviewer, package=second)
        first.refresh_from_db()
        self.assertEqual(first.status, RulePackage.Status.RETIRED)
        rolled_back = rollback_to_package(actor=self.reviewer, target=first, new_version="rules-rollback-first", comment="第二版现场指标异常")
        second.refresh_from_db()
        self.assertEqual(second.status, RulePackage.Status.RETIRED)
        self.assertEqual(rolled_back.status, RulePackage.Status.PUBLISHED)
        self.assertEqual(rolled_back.rollback_of_id, first.id)

    def api_json(self, method, url, payload=None):
        return getattr(self.client, method)(url, data=json.dumps(payload or {}), content_type="application/json")

    def test_rule_api_requires_named_authenticated_profile(self):
        response = self.client.get(reverse("rule-packages-api"))
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "AUTH_REQUIRED")

    def test_runtime_reader_cannot_browse_drafts_or_rule_center(self):
        create_draft(actor=self.configurer, version="rules-private-draft", payload=valid_payload(), change_note="监控不可见草稿", enterprise_scope_ids=self.enterprise_scope_ids)
        self.client.force_login(self.monitor)
        list_response = self.client.get(reverse("rule-packages-api"))
        self.assertEqual(list_response.status_code, 403)
        home_response = self.client.get(reverse("rule-center-home"))
        self.assertEqual(home_response.status_code, 403)

    def test_api_create_submit_approve_publish_runtime_flow(self):
        self.client.force_login(self.configurer)
        create_response = self.api_json("post", reverse("rule-package-create-api"), {
            "version": "rules-api-v1",
            "payload": valid_payload(),
            "changeNote": "API端到端规则",
            "enterpriseScopeIds": self.enterprise_scope_ids,
        })
        self.assertEqual(create_response.status_code, 201)
        package_id = create_response.json()["data"]["rulePackageId"]

        submit_response = self.api_json("post", reverse("rule-package-submit-api", args=[package_id]))
        self.assertEqual(submit_response.status_code, 200)
        self.assertEqual(submit_response.json()["data"]["status"], RulePackage.Status.IN_REVIEW)

        forbidden_review = self.api_json("post", reverse("rule-package-approve-api", args=[package_id]), {"comment": "越权审核"})
        self.assertEqual(forbidden_review.status_code, 403)
        self.assertEqual(forbidden_review.json()["code"], "PERMISSION_DENIED")

        self.client.force_login(self.reviewer)
        approve_response = self.api_json("post", reverse("rule-package-approve-api", args=[package_id]), {"comment": "审核通过"})
        self.assertEqual(approve_response.status_code, 200)
        publish_response = self.api_json("post", reverse("rule-package-publish-api", args=[package_id]))
        self.assertEqual(publish_response.status_code, 200)
        self.assertEqual(publish_response.json()["data"]["status"], RulePackage.Status.PUBLISHED)

        runtime_forbidden = self.client.get(reverse("rule-runtime-api"))
        self.assertEqual(runtime_forbidden.status_code, 403)
        self.client.force_login(self.monitor)
        runtime_response = self.client.get(reverse("rule-runtime-api"))
        self.assertEqual(runtime_response.status_code, 200)
        runtime = runtime_response.json()["data"]["runtimeRuleSet"]
        self.assertEqual(runtime["version"], "rules-api-v1")
        self.assertEqual(runtime["schemaVersion"], 2)
        self.assertEqual(runtime["rules"][0]["handlingMode"], "AUTO")
        self.assertEqual(runtime["rules"][0]["channels"][0]["type"], "TEXT")
        self.assertFalse(runtime["allowLiveActions"])
        self.assertEqual(runtime_response.json()["data"]["responseAssets"][0]["assetKey"], "text-smoking-v1")

    def test_voice_rule_runtime_contains_independently_published_asset(self):
        payload = valid_payload()
        payload["rules"][0]["handlingMode"] = "MANUAL"
        payload["rules"][0]["channels"] = [{
            "type": "VOICE",
            "order": 1,
            "templateId": "voice-smoking-v1",
            "assetId": "audio-smoking-v1",
            "recipientType": "DRIVER_TERMINAL",
            "spokenTemplate": "驾驶员，平台已报警，请不要吸烟，注意行车安全。",
        }]
        voice_asset = create_response_asset(
            actor=self.configurer, asset_key="audio-smoking-v1", version="v1", channel_type="VOICE", enterprise_scope_ids=self.enterprise_scope_ids,
            change_note="测试固定语音", voice_base64=pcm_wav_base64(), voice_filename="smoking.wav",
        )
        submit_response_asset(actor=self.configurer, asset=voice_asset)
        review_asset(actor=self.reviewer, asset=voice_asset, approved=True, comment="测试语音已审核")
        publish_asset(actor=self.reviewer, asset=voice_asset)
        draft = create_draft(actor=self.configurer, version="rules-voice-safe", payload=payload, change_note="语音安全闸门", enterprise_scope_ids=self.enterprise_scope_ids)
        submit_for_review(actor=self.configurer, package=draft)
        review_package(actor=self.reviewer, package=draft, approved=True, comment="仅批准规则，不代表资产适配完成")
        publish_package(actor=self.reviewer, package=draft)
        self.client.force_login(self.monitor)
        response_data = self.client.get(reverse("rule-runtime-api")).json()["data"]
        runtime = response_data["runtimeRuleSet"]
        self.assertEqual(runtime["rules"][0]["channels"][0]["type"], "VOICE")
        self.assertEqual(runtime["rules"][0]["handlingMode"], "MANUAL")
        self.assertEqual(response_data["responseAssets"][0]["assetKey"], "audio-smoking-v1")
        self.assertTrue(response_data["responseAssets"][0]["voiceBase64"].startswith("UklGR"))

    def test_rule_publish_rejects_missing_response_asset(self):
        payload = valid_payload()
        payload["rules"][0]["channels"][0]["templateId"] = "text-not-published"
        draft = create_draft(actor=self.configurer, version="rules-missing-asset", payload=payload, change_note="缺少资产", enterprise_scope_ids=self.enterprise_scope_ids)
        submit_for_review(actor=self.configurer, package=draft)
        review_package(actor=self.reviewer, package=draft, approved=True, comment="规则本身通过")
        with self.assertRaises(RuleGovernanceError) as caught:
            publish_package(actor=self.reviewer, package=draft)
        self.assertEqual(caught.exception.code, "RESPONSE_ASSET_NOT_READY")

    def test_rollback_api_creates_new_published_version(self):
        original = create_draft(actor=self.configurer, version="rules-api-original", payload=valid_payload(), change_note="原始版本", enterprise_scope_ids=self.enterprise_scope_ids)
        submit_for_review(actor=self.configurer, package=original)
        review_package(actor=self.reviewer, package=original, approved=True, comment="批准原始版本")
        publish_package(actor=self.reviewer, package=original)
        self.client.force_login(self.reviewer)
        response = self.api_json("post", reverse("rule-package-rollback-api", args=[original.public_id]), {
            "newVersion": "rules-api-rollback",
            "comment": "现场回退验证",
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["data"]["version"], "rules-api-rollback")
        self.assertEqual(RulePackage.objects.filter(status=RulePackage.Status.PUBLISHED).count(), 1)

    def test_rule_scope_must_be_explicit_and_within_actor_grants(self):
        other = EnterpriseScope.objects.create(code="COMPANY-OTHER", name="其他企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        with self.assertRaises(RuleGovernanceError) as missing:
            create_draft(actor=self.configurer, version="rules-no-scope", payload=valid_payload(), change_note="缺少范围", enterprise_scope_ids=[])
        self.assertEqual(missing.exception.code, "ENTERPRISE_SCOPE_REQUIRED")
        with self.assertRaises(RuleGovernanceError) as denied:
            create_draft(actor=self.configurer, version="rules-other-scope", payload=valid_payload(), change_note="越权范围", enterprise_scope_ids=[str(other.public_id)])
        self.assertEqual(denied.exception.code, "ENTERPRISE_SCOPE_DENIED")

    def test_runtime_is_denied_outside_published_package_scope(self):
        outsider = get_user_model().objects.create_user(username="outside-monitor")
        AssistantProfile.objects.create(user=outsider, display_name="外部监控员", employee_code="MONITOR-OUT")
        outside_enterprise = EnterpriseScope.objects.create(code="COMPANY-OUT", name="外部企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        EnterpriseGrant.objects.create(user=outsider, enterprise=outside_enterprise)
        assign_role(user=outsider, role=RoleAssignment.Role.UNIT_USER, assigned_by=outsider)
        draft = create_draft(actor=self.configurer, version="rules-scoped-runtime", payload=valid_payload(), change_note="范围运行时", enterprise_scope_ids=self.enterprise_scope_ids)
        submit_for_review(actor=self.configurer, package=draft)
        review_package(actor=self.reviewer, package=draft, approved=True, comment="范围审核")
        publish_package(actor=self.reviewer, package=draft)
        self.client.force_login(outsider)
        response = self.client.get(reverse("rule-runtime-api"))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "ENTERPRISE_SCOPE_DENIED")
