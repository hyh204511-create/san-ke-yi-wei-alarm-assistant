import base64
import json
import struct

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from apps.governance.models import AssistantProfile, EnterpriseGrant, EnterpriseScope, RoleAssignment
from apps.governance.services import assign_role

from .models import ResponseAsset, ResponseAssetEvent
from .services import ResponseGovernanceError, create_draft, publish_asset, review_asset, submit_for_review, update_draft


def pcm_wav_base64(duration_ms=100):
    sample_rate = 8000
    pcm = b"\x00\x00" * max(1, round(sample_rate * duration_ms / 1000))
    fmt = struct.pack("<HHIIHH", 1, 1, sample_rate, sample_rate * 2, 2, 16)
    raw = b"RIFF" + struct.pack("<I", 4 + (8 + len(fmt)) + (8 + len(pcm))) + b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(pcm)) + pcm
    return base64.b64encode(raw).decode("ascii")


class ResponseGovernanceTests(TestCase):
    def setUp(self):
        users = get_user_model()
        self.configurer = users.objects.create_user(username="response-configurer")
        self.reviewer = users.objects.create_user(username="response-reviewer")
        self.monitor = users.objects.create_user(username="response-monitor")
        for user, name, code in [
            (self.configurer, "响应配置员", "RESP-CFG"), (self.reviewer, "响应审核员", "RESP-REV"), (self.monitor, "响应监控员", "RESP-MON")
        ]:
            AssistantProfile.objects.create(user=user, display_name=name, employee_code=code)
        self.enterprise = EnterpriseScope.objects.create(code="COMPANY-RESP", name="响应测试企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        for user in [self.configurer, self.reviewer, self.monitor]:
            EnterpriseGrant.objects.create(user=user, enterprise=self.enterprise)
        assign_role(user=self.configurer, role=RoleAssignment.Role.RULE_CONFIGURER, assigned_by=self.configurer)
        assign_role(user=self.reviewer, role=RoleAssignment.Role.RULE_REVIEWER, assigned_by=self.reviewer)
        assign_role(user=self.monitor, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.monitor)
        self.scopes = [str(self.enterprise.public_id)]

    def test_text_asset_requires_separate_review_and_publish(self):
        asset = create_draft(
            actor=self.configurer, asset_key="text-fatigue-v1", version="v1.0.0", channel_type="TEXT", enterprise_scope_ids=self.scopes,
            change_note="疲劳提醒固定文本", text_template="{vehicleNo} 发生 {alarmName}，请立即安全停车休息。",
        )
        submit_for_review(actor=self.configurer, asset=asset)
        with self.assertRaises(ResponseGovernanceError):
            review_asset(actor=self.configurer, asset=asset, approved=True, comment="本人审核")
        review_asset(actor=self.reviewer, asset=asset, approved=True, comment="话术边界和变量确认")
        published = publish_asset(actor=self.reviewer, asset=asset)
        self.assertEqual(published.status, ResponseAsset.Status.PUBLISHED)
        self.assertEqual(ResponseAssetEvent.objects.filter(asset=asset).count(), 4)

    def test_draft_can_be_updated_but_submitted_content_is_immutable(self):
        asset = create_draft(
            actor=self.configurer, asset_key="text-update-v1", version="v1", channel_type="TEXT", enterprise_scope_ids=self.scopes,
            change_note="初稿", text_template="{vehicleNo} 请注意",
        )
        original_hash = asset.content_hash
        update_draft(actor=self.configurer, asset=asset, change_note="调整话术", text_template="{vehicleNo} 发生 {alarmName}")
        asset.refresh_from_db()
        self.assertNotEqual(asset.content_hash, original_hash)
        submit_for_review(actor=self.configurer, asset=asset)
        with self.assertRaises(ResponseGovernanceError):
            update_draft(actor=self.configurer, asset=asset, text_template="再次修改")

    def test_text_rejects_unapproved_variable(self):
        with self.assertRaises(ResponseGovernanceError) as caught:
            create_draft(
                actor=self.configurer, asset_key="text-invalid", version="v1", channel_type="TEXT", enterprise_scope_ids=self.scopes,
                change_note="非法变量", text_template="请联系 {driverPhone}",
            )
        self.assertEqual(caught.exception.code, "INVALID_TEXT_VARIABLE")

    def test_voice_asset_validates_pcm_format_and_runtime_payload(self):
        asset = create_draft(
            actor=self.configurer, asset_key="audio-fatigue-v1", version="v1", channel_type="VOICE", enterprise_scope_ids=self.scopes,
            change_note="固定语音", voice_base64=pcm_wav_base64(), voice_filename="fatigue.wav",
        )
        submit_for_review(actor=self.configurer, asset=asset)
        review_asset(actor=self.reviewer, asset=asset, approved=True, comment="音频内容和格式确认")
        publish_asset(actor=self.reviewer, asset=asset)
        self.client.force_login(self.monitor)
        response = self.client.get(reverse("response-asset-runtime-api"))
        self.assertEqual(response.status_code, 200)
        runtime = response.json()["data"][0]
        self.assertEqual(runtime["assetKey"], "audio-fatigue-v1")
        self.assertTrue(runtime["voiceBase64"].startswith("UklGR"))

    def test_invalid_voice_is_rejected(self):
        with self.assertRaises(ResponseGovernanceError) as caught:
            create_draft(
                actor=self.configurer, asset_key="audio-invalid", version="v1", channel_type="VOICE", enterprise_scope_ids=self.scopes,
                change_note="非法音频", voice_base64=base64.b64encode(b"not-wave").decode("ascii"), voice_filename="bad.wav",
            )
        self.assertEqual(caught.exception.code, "INVALID_VOICE_ASSET")

    def test_asset_key_cannot_change_channel_type_between_versions(self):
        create_draft(
            actor=self.configurer, asset_key="fixed-channel-key", version="text-v1", channel_type="TEXT", enterprise_scope_ids=self.scopes,
            change_note="文本首版", text_template="{vehicleNo} 请注意",
        )
        with self.assertRaises(ResponseGovernanceError) as caught:
            create_draft(
                actor=self.configurer, asset_key="fixed-channel-key", version="voice-v2", channel_type="VOICE", enterprise_scope_ids=self.scopes,
                change_note="错误改为语音", voice_base64=pcm_wav_base64(), voice_filename="wrong.wav",
            )
        self.assertEqual(caught.exception.code, "ASSET_CHANNEL_CONFLICT")

    def test_runtime_and_list_are_separated(self):
        self.client.force_login(self.monitor)
        self.assertEqual(self.client.get(reverse("response-asset-list-api")).status_code, 403)
        self.assertEqual(self.client.get(reverse("response-asset-runtime-api")).status_code, 200)

    def test_api_create_flow(self):
        self.client.force_login(self.configurer)
        response = self.client.post(reverse("response-asset-create-api"), data=json.dumps({
            "assetKey": "text-api-v1", "version": "v1", "channelType": "TEXT", "enterpriseScopeIds": self.scopes,
            "changeNote": "API文本", "textTemplate": "{vehicleNo} 请注意 {alarmName}",
        }), content_type="application/json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["data"]["status"], ResponseAsset.Status.DRAFT)
