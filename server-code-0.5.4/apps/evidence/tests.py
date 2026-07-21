import hashlib
import json
import tempfile
from datetime import timedelta
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import connection
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.disposals.models import DisposalCase
from apps.governance.models import AssistantProfile, AuditEvent, EnterpriseGrant, EnterpriseScope, RoleAssignment
from apps.governance.services import assign_role
from apps.reporting.models import AlarmFact

from .models import EvidenceRequest
from .services import decrypt_package


class EvidenceFlowTests(TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.settings_override = override_settings(EVIDENCE_EXPORT_DIR=self.temp_dir.name)
        self.settings_override.enable()
        users = get_user_model()
        self.requester = users.objects.create_user(username="evidence-requester")
        self.reviewer = users.objects.create_user(username="evidence-reviewer")
        self.outsider = users.objects.create_user(username="evidence-outsider")
        for user, name, code in [(self.requester, "证据申请员", "EVI-REQ"), (self.reviewer, "证据审批员", "EVI-REV"), (self.outsider, "外部审计员", "EVI-OUT")]:
            AssistantProfile.objects.create(user=user, display_name=name, employee_code=code)
            assign_role(user=user, role=RoleAssignment.Role.RULE_REVIEWER, assigned_by=user)
        self.enterprise = EnterpriseScope.objects.create(code="EVIDENCE-COMPANY", name="证据测试企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        outside = EnterpriseScope.objects.create(code="EVIDENCE-OUT", name="外部证据企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        EnterpriseGrant.objects.create(user=self.requester, enterprise=self.enterprise, can_view_sensitive=True)
        EnterpriseGrant.objects.create(user=self.reviewer, enterprise=self.enterprise, can_view_sensitive=True)
        EnterpriseGrant.objects.create(user=self.outsider, enterprise=outside, can_view_sensitive=True)
        now = timezone.now()
        self.fact = AlarmFact.objects.create(
            event_id="alarm:id:8800000000000000001", alarm_id="8800000000000000001", enterprise=self.enterprise,
            company_name_snapshot=self.enterprise.name, source_kind="REALTIME", alarm_name="疲劳驾驶报警", alarm_time=now,
            vehicle_id="vehicle-evidence", vehicle_no="湘A证据01", final_state="MANUAL_REQUIRED",
            event_snapshot={"eventId": "alarm:id:8800000000000000001", "vehicleNo": "湘A证据01", "driverName": "测试司机", "location": "敏感位置", "authorization": "must-not-export", "sources": {"vehicleNo": [{"endpoint": "realtime"}]}},
            decision_snapshot={"action": "MANUAL_REVIEW", "ruleSetVersion": "rules-v2"},
            action_snapshot={"status": "FAILED", "token": "must-not-export"}, first_seen_at=now, last_seen_at=now, ingested_by=self.requester,
        )
        DisposalCase.objects.create(
            event_id=self.fact.event_id, alarm_id=self.fact.alarm_id, enterprise=self.enterprise, source_kind="REALTIME",
            alarm_name=self.fact.alarm_name, vehicle_no=self.fact.vehicle_no, event_snapshot=self.fact.event_snapshot,
            latest_event_snapshot=self.fact.event_snapshot, decision_snapshot=self.fact.decision_snapshot, resolution_note="人工核查中",
        )

    def tearDown(self):
        self.settings_override.disable()
        self.temp_dir.cleanup()

    def post_json(self, url, data):
        return self.client.post(url, data=json.dumps(data), content_type="application/json")

    def create_request(self):
        self.client.force_login(self.requester)
        response = self.post_json(reverse("evidence-create-api"), {
            "enterpriseId": str(self.enterprise.public_id), "eventIds": [self.fact.event_id], "purpose": "监管事件证据核查",
            "requestedFields": ["EVENT", "FIELD_SOURCES", "DECISION", "ACTION", "DISPOSAL"],
        })
        self.assertEqual(response.status_code, 201)
        return response.json()["data"]

    def test_requester_cannot_approve_own_evidence_package(self):
        item = self.create_request()
        response = self.post_json(reverse("evidence-review-api", args=[item["evidenceRequestId"]]), {"approved": True, "comment": "本人批准"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "EVIDENCE_REVIEW_SEPARATION")

    def test_review_rejects_string_boolean(self):
        item = self.create_request()
        self.client.force_login(self.reviewer)
        response = self.post_json(reverse("evidence-review-api", args=[item["evidenceRequestId"]]), {"approved": "false", "comment": "类型错误"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["code"], "INVALID_BOOLEAN")

    def test_approved_package_is_encrypted_hashed_and_redacts_credentials(self):
        item = self.create_request()
        self.client.force_login(self.reviewer)
        approved = self.post_json(reverse("evidence-review-api", args=[item["evidenceRequestId"]]), {"approved": True, "comment": "用途和范围符合审计要求"})
        self.assertEqual(approved.status_code, 200)
        data = approved.json()["data"]
        self.assertEqual(data["status"], EvidenceRequest.Status.READY)
        self.assertEqual(data["encryptionAlgorithm"], "AES-256-GCM")
        download = self.client.get(reverse("evidence-download-api", args=[item["evidenceRequestId"]]))
        content = b"".join(download.streaming_content)
        self.assertTrue(content.startswith(b"HNEVID1"))
        self.assertNotIn("湘A证据01".encode("utf-8"), content)
        self.assertEqual(hashlib.sha256(content).hexdigest(), data["fileHash"])
        request = EvidenceRequest.objects.get(public_id=item["evidenceRequestId"])
        payload = decrypt_package(request, content)
        self.assertEqual(payload["classification"], "L4_HIGH_SENSITIVITY_EVIDENCE")
        self.assertEqual(payload["records"][0]["event"]["authorization"], "[REDACTED]")
        self.assertEqual(payload["records"][0]["action"]["token"], "[REDACTED]")
        self.assertTrue(AuditEvent.objects.filter(event_type="EVIDENCE_DOWNLOADED").exists())

    def test_request_scope_and_fields_are_encrypted_in_database(self):
        item = self.create_request()
        request = EvidenceRequest.objects.get(public_id=item["evidenceRequestId"])
        with connection.cursor() as cursor:
            cursor.execute("SELECT event_ids, requested_fields FROM assistant_evidence_requests WHERE id = %s", [request.pk])
            raw = cursor.fetchone()
        self.assertTrue(raw[0].startswith("enc:v1:"))
        self.assertTrue(raw[1].startswith("enc:v1:"))
        self.assertNotIn(self.fact.event_id, raw[0])

    def test_out_of_scope_auditor_cannot_review_or_download(self):
        item = self.create_request()
        self.client.force_login(self.outsider)
        response = self.post_json(reverse("evidence-review-api", args=[item["evidenceRequestId"]]), {"approved": True, "comment": "越权审批"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "ENTERPRISE_SCOPE_DENIED")

    def test_review_fails_cleanly_when_source_event_was_removed(self):
        item = self.create_request()
        self.fact.delete()
        self.client.force_login(self.reviewer)
        response = self.post_json(reverse("evidence-review-api", args=[item["evidenceRequestId"]]), {"approved": True, "comment": "检查源事件"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "EVIDENCE_SOURCE_CHANGED")

    def test_expired_evidence_is_deleted_with_audit(self):
        item = self.create_request()
        self.client.force_login(self.reviewer)
        self.post_json(reverse("evidence-review-api", args=[item["evidenceRequestId"]]), {"approved": True, "comment": "批准短期证据"})
        request = EvidenceRequest.objects.get(public_id=item["evidenceRequestId"])
        path = Path(request.file_path)
        request.expires_at = timezone.now() - timedelta(seconds=1)
        request.save(update_fields=["expires_at", "updated_at"])
        call_command("purge_expired_evidence", verbosity=0)
        request.refresh_from_db()
        self.assertEqual(request.status, EvidenceRequest.Status.DELETED)
        self.assertFalse(path.exists())
        self.assertTrue(AuditEvent.objects.filter(event_type="EVIDENCE_DELETED").exists())

    def test_invalid_fields_and_missing_event_are_rejected(self):
        self.client.force_login(self.requester)
        invalid_fields = self.post_json(reverse("evidence-create-api"), {
            "enterpriseId": str(self.enterprise.public_id), "eventIds": [self.fact.event_id], "purpose": "测试", "requestedFields": ["COOKIE"],
        })
        self.assertEqual(invalid_fields.status_code, 422)
        missing = self.post_json(reverse("evidence-create-api"), {
            "enterpriseId": str(self.enterprise.public_id), "eventIds": ["alarm:id:missing"], "purpose": "测试", "requestedFields": ["EVENT"],
        })
        self.assertEqual(missing.status_code, 404)
