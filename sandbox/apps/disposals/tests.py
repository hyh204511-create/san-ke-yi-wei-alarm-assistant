import json

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.urls import reverse

from apps.governance.models import AssistantProfile, EnterpriseGrant, EnterpriseScope, RoleAssignment
from apps.governance.services import assign_role, claim_shift

from .models import DisposalCase, DisposalEvent


def event_payload(company_id="COMPANY-001", source_kind="REALTIME"):
    return {
        "eventId": "alarm:event-001",
        "alarmId": "9000000000000000001",
        "sourceKind": source_kind,
        "alarmName": "疲劳驾驶报警",
        "vehicleNo": "湘A测001",
        "companyId": company_id,
        "companyName": "测试运输企业",
        "alarmTime": "2026-07-19 12:00:00",
    }


def decision_payload():
    return {"decisionId": "decision-001", "action": "MANUAL_REVIEW", "ruleSetVersion": "rules-v2", "reason": "文本通道待适配"}


class DisposalFlowTests(TestCase):
    def setUp(self):
        users = get_user_model()
        self.monitor = users.objects.create_user(username="monitor-disposal", password="test-password")
        self.reviewer = users.objects.create_user(username="reviewer-disposal", password="test-password")
        self.outsider = users.objects.create_user(username="outside-disposal", password="test-password")
        AssistantProfile.objects.create(user=self.monitor, display_name="处置监控员", employee_code="DIS-MON")
        AssistantProfile.objects.create(user=self.reviewer, display_name="处置复核员", employee_code="DIS-REV")
        AssistantProfile.objects.create(user=self.outsider, display_name="外部监控员", employee_code="DIS-OUT")
        self.enterprise = EnterpriseScope.objects.create(code="COMPANY-001", name="测试运输企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        outside = EnterpriseScope.objects.create(code="COMPANY-OUT", name="外部运输企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        EnterpriseGrant.objects.create(user=self.monitor, enterprise=self.enterprise)
        EnterpriseGrant.objects.create(user=self.reviewer, enterprise=self.enterprise)
        EnterpriseGrant.objects.create(user=self.outsider, enterprise=outside)
        assign_role(user=self.monitor, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.monitor)
        assign_role(user=self.reviewer, role=RoleAssignment.Role.RULE_REVIEWER, assigned_by=self.reviewer)
        assign_role(user=self.outsider, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.outsider)
        claim_shift(user=self.monitor, platform_account_ref="platform-monitor", workstation_id="WS-MONITOR")
        claim_shift(user=self.outsider, platform_account_ref="platform-outsider", workstation_id="WS-OUTSIDE")

    def post_json(self, url, data):
        token_response = self.client.get(reverse("assistant-action-token-api"))
        token = token_response.json().get("data", {}).get("actionToken", "")
        return self.client.post(url, data=json.dumps(data), content_type="application/json", HTTP_X_ASSISTANT_ACTION_TOKEN=token)

    def create_case(self):
        self.client.force_login(self.monitor)
        response = self.post_json(reverse("disposal-upsert-api"), {"event": event_payload(), "decision": decision_payload()})
        self.assertEqual(response.status_code, 201)
        return response.json()["data"]

    def test_complete_manual_case_requires_different_reviewer(self):
        case = self.create_case()
        takeover = self.post_json(reverse("disposal-takeover-api", args=[case["caseId"]]), {"expectedVersion": case["version"]})
        self.assertEqual(takeover.status_code, 200)
        current = takeover.json()["data"]
        note = self.post_json(reverse("disposal-note-api", args=[case["caseId"]]), {"expectedVersion": current["version"], "comment": "已电话核实并要求停车检查"})
        self.assertEqual(note.status_code, 200)
        current = note.json()["data"]
        completed = self.post_json(reverse("disposal-complete-api", args=[case["caseId"]]), {
            "expectedVersion": current["version"],
            "resolutionCode": "DRIVER_CONTACTED",
            "resolutionNote": "司机已确认停车休息，等待复核",
        })
        self.assertEqual(completed.status_code, 200)
        current = completed.json()["data"]
        self.assertEqual(current["status"], DisposalCase.Status.PENDING_REVIEW)

        self.client.force_login(self.reviewer)
        reviewed = self.post_json(reverse("disposal-review-api", args=[case["caseId"]]), {
            "expectedVersion": current["version"], "approved": True, "comment": "证据和处置过程完整，复核通过",
        })
        self.assertEqual(reviewed.status_code, 200)
        self.assertEqual(reviewed.json()["data"]["status"], DisposalCase.Status.COMPLETED)
        self.assertEqual(DisposalEvent.objects.filter(disposal_case__public_id=case["caseId"]).count(), 5)

    def test_reviewer_can_reject_and_monitor_resubmits(self):
        case = self.create_case()
        current = self.post_json(reverse("disposal-takeover-api", args=[case["caseId"]]), {"expectedVersion": case["version"]}).json()["data"]
        current = self.post_json(reverse("disposal-complete-api", args=[case["caseId"]]), {
            "expectedVersion": current["version"], "resolutionCode": "CHECKED", "resolutionNote": "初次提交",
        }).json()["data"]
        self.client.force_login(self.reviewer)
        rejected = self.post_json(reverse("disposal-review-api", args=[case["caseId"]]), {
            "expectedVersion": current["version"], "approved": False, "comment": "缺少司机确认信息",
        })
        self.assertEqual(rejected.status_code, 200)
        self.assertEqual(rejected.json()["data"]["status"], DisposalCase.Status.IN_MANUAL)

    def test_out_of_scope_user_cannot_list_or_mutate_case(self):
        case = self.create_case()
        self.client.force_login(self.outsider)
        listing = self.client.get(reverse("disposal-list-api"))
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["data"], [])
        response = self.post_json(reverse("disposal-takeover-api", args=[case["caseId"]]), {"expectedVersion": case["version"]})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "ENTERPRISE_SCOPE_DENIED")

    def test_review_rejects_string_boolean(self):
        case = self.create_case()
        current = self.post_json(reverse("disposal-takeover-api", args=[case["caseId"]]), {"expectedVersion": case["version"]}).json()["data"]
        current = self.post_json(reverse("disposal-complete-api", args=[case["caseId"]]), {
            "expectedVersion": current["version"], "resolutionCode": "CHECKED", "resolutionNote": "人工确认"
        }).json()["data"]
        self.client.force_login(self.reviewer)
        response = self.post_json(reverse("disposal-review-api", args=[case["caseId"]]), {
            "expectedVersion": current["version"], "approved": "false", "comment": "类型错误"
        })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["code"], "INVALID_BOOLEAN")

    def test_prewarning_does_not_create_real_time_disposal_case(self):
        self.client.force_login(self.monitor)
        response = self.post_json(reverse("disposal-upsert-api"), {"event": event_payload(source_kind="PREWARNING"), "decision": decision_payload()})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "SOURCE_NOT_ACTIONABLE")

    def test_stale_case_version_is_rejected(self):
        case = self.create_case()
        first = self.post_json(reverse("disposal-takeover-api", args=[case["caseId"]]), {"expectedVersion": case["version"]})
        self.assertEqual(first.status_code, 200)
        stale = self.post_json(reverse("disposal-note-api", args=[case["caseId"]]), {"expectedVersion": case["version"], "comment": "过期页面提交"})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["code"], "STALE_CASE_VERSION")

    def test_identical_capture_retry_does_not_churn_case_version_or_audit(self):
        case = self.create_case()
        repeated = self.post_json(reverse("disposal-upsert-api"), {"event": event_payload(), "decision": decision_payload()})
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["data"]["version"], case["version"])
        self.assertEqual(DisposalEvent.objects.filter(disposal_case__public_id=case["caseId"]).count(), 1)

    def test_disposal_event_is_append_only(self):
        case = self.create_case()
        event = DisposalEvent.objects.get(disposal_case__public_id=case["caseId"])
        event.comment = "尝试覆盖"
        with self.assertRaises(ValidationError):
            event.save()
        with self.assertRaises(ValidationError):
            event.delete()

    def test_api_requires_authenticated_named_user(self):
        response = self.client.get(reverse("disposal-list-api"))
        self.assertEqual(response.status_code, 401)

    def test_mutation_rejects_missing_action_token(self):
        self.client.force_login(self.monitor)
        response = self.client.post(reverse("disposal-upsert-api"), data=json.dumps({"event": event_payload(), "decision": decision_payload()}), content_type="application/json")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "ACTION_TOKEN_REQUIRED")
