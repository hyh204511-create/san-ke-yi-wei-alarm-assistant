from datetime import timedelta
import base64
import json
import os
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.core import serializers
from django.db import connection
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from . import services
from .encrypted_fields import decrypt_json, encrypt_json
from .models import AssistantProfile, AuditEvent, DeviceRegistration, DutyShift, EnterpriseGrant, EnterpriseScope, RoleAssignment, SessionKeepaliveAudit, SessionKeepalivePolicy, VoiceInteractionPolicy
from .services import GovernanceError, assign_role, claim_shift, release_shift
from config.settings import postgresql_database_config
from .management.commands.audit_database_migration import migration_models


class EncryptedFieldKeyRotationTests(TestCase):
    @staticmethod
    def encoded_key(fill):
        return base64.urlsafe_b64encode(bytes([fill]) * 32).decode("ascii").rstrip("=")

    @override_settings(ALLOW_DERIVED_DATA_KEYS=False)
    def test_fallback_key_decrypts_legacy_value_and_primary_encrypts_new_value(self):
        old_key = self.encoded_key(1)
        new_key = self.encoded_key(2)
        with patch.dict(os.environ, {"SENSITIVE_DATA_KEY": old_key, "SENSITIVE_DATA_KEY_FALLBACKS": ""}, clear=False):
            legacy = encrypt_json({"status": "legacy"})
        with patch.dict(os.environ, {"SENSITIVE_DATA_KEY": new_key, "SENSITIVE_DATA_KEY_FALLBACKS": old_key}, clear=False):
            self.assertEqual(decrypt_json(legacy), {"status": "legacy"})
            current = encrypt_json({"status": "current"})
        with patch.dict(os.environ, {"SENSITIVE_DATA_KEY": new_key, "SENSITIVE_DATA_KEY_FALLBACKS": ""}, clear=False):
            self.assertEqual(decrypt_json(current), {"status": "current"})

    @override_settings(ALLOW_DERIVED_DATA_KEYS=False)
    def test_invalid_fallback_key_is_rejected(self):
        with patch.dict(os.environ, {"SENSITIVE_DATA_KEY": self.encoded_key(3), "SENSITIVE_DATA_KEY_FALLBACKS": "invalid"}, clear=False):
            with self.assertRaisesMessage(ImproperlyConfigured, "SENSITIVE_DATA_KEY_FALLBACKS item 1"):
                encrypt_json({"status": "blocked"})

    def test_fixture_serialization_uses_valid_json(self):
        field = DeviceRegistration._meta.get_field("platform_permission_summary")
        serialized = field.value_to_string(SimpleNamespace(platform_permission_summary={"hasQuery": True, "labels": ["实时报警"]}))
        self.assertEqual(json.loads(serialized), {"hasQuery": True, "labels": ["实时报警"]})

    def test_django_serializer_round_trip_preserves_sensitive_json_types(self):
        user = get_user_model().objects.create_user(username="fixture-user")
        values = {"enabled": True, "count": 2, "items": ["报警", None], "nested": {"ratio": 0.5}}
        device = DeviceRegistration.objects.create(
            device_id="fixture-device", user=user, platform_permission_summary=values,
        )
        fixture = serializers.serialize("json", [device])
        self.assertNotIn("enc:v1:", fixture)
        restored = next(serializers.deserialize("json", fixture)).object
        self.assertEqual(restored.platform_permission_summary, values)
        device.delete()
        restored.save()
        self.assertEqual(DeviceRegistration.objects.get(pk=restored.pk).platform_permission_summary, values)
        table = connection.ops.quote_name(DeviceRegistration._meta.db_table)
        column = connection.ops.quote_name("platform_permission_summary")
        with connection.cursor() as cursor:
            cursor.execute(f"SELECT {column} FROM {table} WHERE id = %s", [restored.pk])
            self.assertTrue(cursor.fetchone()[0].startswith("enc:v1:"))

    def test_postgresql_url_decodes_encoded_credentials_and_database_name(self):
        config = postgresql_database_config(
            "postgresql://assistant%40user:p%40ss%3Aword@localhost/assistant%2Ddb",
            debug=True,
        )
        self.assertEqual(config["USER"], "assistant@user")
        self.assertEqual(config["PASSWORD"], "p@ss:word")
        self.assertEqual(config["NAME"], "assistant-db")

    def test_migration_audit_scope_excludes_recreated_system_models(self):
        labels = {model._meta.label_lower for model in migration_models()}
        self.assertIn("auth.user", labels)
        self.assertIn("governance.deviceregistration", labels)
        self.assertNotIn("auth.permission", labels)
        self.assertNotIn("auth.group", labels)
        self.assertNotIn("contenttypes.contenttype", labels)
        self.assertNotIn("sessions.session", labels)


class GovernanceTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="monitor-a", password="test-password")
        self.admin = get_user_model().objects.create_user(username="admin-a", password="test-password")
        AssistantProfile.objects.create(user=self.user, display_name="测试监控员", employee_code="EMP-001")
        AssistantProfile.objects.create(user=self.admin, display_name="测试管理员", employee_code="EMP-ADMIN")
        self.enterprise = EnterpriseScope.objects.create(code="ENT-001", name="测试运输企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        EnterpriseGrant.objects.create(user=self.user, enterprise=self.enterprise)

    def test_ready_rejects_sqlite_without_exposing_connection_details(self):
        response = self.client.get("/ready")
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["code"], "POSTGRESQL_REQUIRED")
        serialized = json.dumps(payload).lower()
        for secret_name in ("password", "user", "host", "database_url"):
            self.assertNotIn(secret_name, serialized)

    def test_unit_user_cannot_also_be_rule_reviewer(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        with self.assertRaises(GovernanceError) as caught:
            assign_role(user=self.user, role=RoleAssignment.Role.RULE_REVIEWER, assigned_by=self.admin)
        self.assertEqual(caught.exception.code, "ROLE_SEPARATION_VIOLATION")
        self.assertEqual(RoleAssignment.objects.filter(user=self.user).count(), 1)

    def test_rule_configurer_cannot_also_be_rule_reviewer(self):
        assign_role(user=self.user, role=RoleAssignment.Role.RULE_CONFIGURER, assigned_by=self.admin)
        with self.assertRaises(GovernanceError) as caught:
            assign_role(user=self.user, role=RoleAssignment.Role.RULE_REVIEWER, assigned_by=self.admin)
        self.assertEqual(caught.exception.code, "ROLE_SEPARATION_VIOLATION")
        self.assertEqual(RoleAssignment.objects.filter(user=self.user).count(), 1)

    def test_monitor_operator_cannot_also_be_collector(self):
        assign_role(user=self.user, role=RoleAssignment.Role.MONITOR_OPERATOR, assigned_by=self.admin)
        with self.assertRaises(GovernanceError) as caught:
            assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        self.assertEqual(caught.exception.code, "ROLE_SEPARATION_VIOLATION")
        self.assertEqual(RoleAssignment.objects.filter(user=self.user).count(), 1)

    def test_system_admin_can_export_reports_but_not_execute_business_actions(self):
        assign_role(user=self.admin, role=RoleAssignment.Role.SYSTEM_ADMIN, assigned_by=self.admin)
        self.client.force_login(self.admin)
        data = self.client.get("/assistant/api/me").json()["data"]
        self.assertIn("system.configure", data["permissions"])
        self.assertIn("report.view", data["permissions"])
        self.assertIn("report.generate", data["permissions"])
        self.assertIn("report.publish", data["permissions"])
        self.assertIn("export.masked", data["permissions"])
        self.assertNotIn("action.execute", data["permissions"])

    def test_collector_and_rule_configurer_permissions_are_narrow(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        collector_permissions = set(services.permissions_for_roles([RoleAssignment.Role.UNIT_USER]))
        self.assertEqual(collector_permissions, {"alarm.view", "rule.runtime", "session.keepalive.execute"})
        configurer_permissions = set(services.permissions_for_roles([RoleAssignment.Role.RULE_CONFIGURER]))
        self.assertIn("rule.draft", configurer_permissions)
        self.assertIn("rule.submit", configurer_permissions)
        self.assertNotIn("export.masked", configurer_permissions)
        self.assertNotIn("report.generate", configurer_permissions)
        self.assertNotIn("action.execute", configurer_permissions)

    def test_current_user_returns_roles_and_enterprise_scope(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin, request_id="req-test")
        self.client.force_login(self.user)
        response = self.client.get("/assistant/api/me")
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(data["displayName"], "测试监控员")
        self.assertEqual(data["roles"], ["UNIT_USER"])
        self.assertEqual(data["enterpriseScopes"][0]["enterpriseCode"], "ENT-001")
        self.assertEqual(AuditEvent.objects.filter(event_type="ROLE_ASSIGNED").count(), 1)

    def test_group_grant_expands_to_active_descendants(self):
        group = EnterpriseScope.objects.create(code="GROUP-001", name="测试集团", scope_type=EnterpriseScope.ScopeType.GROUP)
        branch = EnterpriseScope.objects.create(code="BRANCH-001", name="测试分公司", scope_type=EnterpriseScope.ScopeType.BRANCH, parent=group)
        child = EnterpriseScope.objects.create(code="ENT-CHILD", name="子企业", scope_type=EnterpriseScope.ScopeType.ENTERPRISE, parent=branch)
        EnterpriseGrant.objects.create(user=self.user, enterprise=group, can_view_sensitive=True)
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        self.client.force_login(self.user)
        scopes = self.client.get("/assistant/api/me").json()["data"]["enterpriseScopes"]
        by_code = {scope["enterpriseCode"]: scope for scope in scopes}
        self.assertIn(child.code, by_code)
        self.assertTrue(by_code[child.code]["canViewSensitive"])
        self.assertEqual(by_code[child.code]["inheritedFromEnterpriseId"], str(group.public_id))

    def test_current_user_requires_login(self):
        response = self.client.get("/assistant/api/me")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "AUTH_REQUIRED")

    def test_authenticated_assistant_can_request_csrf_token(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        self.client.force_login(self.user)
        response = self.client.get("/assistant/api/csrf")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["data"]["csrfToken"])

    def test_authenticated_assistant_can_request_short_lived_action_token(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        self.client.force_login(self.user)
        response = self.client.get("/assistant/api/action-token")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["expiresInSeconds"], 300)
        self.assertTrue(response.json()["data"]["actionToken"])

    def test_plain_django_account_has_no_assistant_access(self):
        plain_user = get_user_model().objects.create_user(username="plain-user", password="test-password")
        self.client.force_login(plain_user)
        response = self.client.get("/assistant/api/me")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "ASSISTANT_PROFILE_REQUIRED")

    def test_login_page_establishes_named_session(self):
        response = self.client.post("/assistant/login", {"username": "monitor-a", "password": "test-password"})
        self.assertEqual(response.status_code, 302)
        identity = self.client.get("/assistant/api/me")
        self.assertEqual(identity.status_code, 200)
        self.assertEqual(identity.json()["data"]["employeeCode"], "EMP-001")

    def test_login_rejects_account_without_profile(self):
        get_user_model().objects.create_user(username="plain-login", password="test-password")
        response = self.client.post("/assistant/login", {"username": "plain-login", "password": "test-password"})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "没有有效的实名助手档案")

    def test_unit_user_claims_and_releases_named_shift(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        shift = claim_shift(user=self.user, platform_account_ref="platform-duty-a", workstation_id="SHA-OFFICE-01", request_id="req-shift")
        self.assertEqual(DutyShift.objects.filter(ended_at__isnull=True).count(), 1)
        self.client.force_login(self.user)
        identity = self.client.get("/assistant/api/me").json()["data"]
        self.assertEqual(identity["activeShift"]["workstationId"], "SHA-OFFICE-01")
        release_shift(user=self.user, request_id="req-release")
        self.assertEqual(DutyShift.objects.filter(ended_at__isnull=True).count(), 0)
        self.assertEqual(AuditEvent.objects.filter(event_type__in=["SHIFT_CLAIMED", "SHIFT_RELEASED"]).count(), 2)

    def test_workstation_cannot_be_claimed_by_two_people(self):
        reviewer = get_user_model().objects.create_user(username="reviewer-a", password="test-password")
        AssistantProfile.objects.create(user=reviewer, display_name="测试复核员", employee_code="EMP-002")
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        assign_role(user=reviewer, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        claim_shift(user=self.user, platform_account_ref="platform-duty-a", workstation_id="SHA-OFFICE-01")
        with self.assertRaises(GovernanceError) as caught:
            claim_shift(user=reviewer, platform_account_ref="platform-duty-b", workstation_id="SHA-OFFICE-01")
        self.assertEqual(caught.exception.code, "WORKSTATION_OCCUPIED")

    def test_platform_account_cannot_be_claimed_from_two_workstations(self):
        reviewer = get_user_model().objects.create_user(username="reviewer-platform", password="test-password")
        AssistantProfile.objects.create(user=reviewer, display_name="平台账号复核员", employee_code="EMP-003")
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        assign_role(user=reviewer, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        claim_shift(user=self.user, platform_account_ref="shared-platform-account", workstation_id="SHA-OFFICE-01")
        with self.assertRaises(GovernanceError) as caught:
            claim_shift(user=reviewer, platform_account_ref="shared-platform-account", workstation_id="SHA-OFFICE-02")
        self.assertEqual(caught.exception.code, "PLATFORM_ACCOUNT_OCCUPIED")

    def test_non_duty_role_cannot_claim_shift(self):
        assign_role(user=self.user, role=RoleAssignment.Role.RULE_CONFIGURER, assigned_by=self.admin)
        with self.assertRaises(GovernanceError) as caught:
            claim_shift(user=self.user, platform_account_ref="platform-duty-a", workstation_id="SHA-OFFICE-01")
        self.assertEqual(caught.exception.code, "SHIFT_ROLE_REQUIRED")

    def test_inactive_named_profile_cannot_claim_shift(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        profile = self.user.assistant_profile
        profile.is_active = False
        profile.save(update_fields=["is_active", "updated_at"])
        with self.assertRaises(GovernanceError) as caught:
            claim_shift(user=self.user, platform_account_ref="platform-duty-a", workstation_id="SHA-OFFICE-01")
        self.assertEqual(caught.exception.code, "ASSISTANT_PROFILE_REQUIRED")

    def test_system_admin_assigns_role_and_enterprise_scope_by_api(self):
        assign_role(user=self.admin, role=RoleAssignment.Role.SYSTEM_ADMIN, assigned_by=self.admin)
        self.client.force_login(self.admin)
        role_response = self.client.post(
            f"/assistant/api/users/{self.user.pk}/roles/assign",
            data=json.dumps({"role": "UNIT_USER"}),
            content_type="application/json",
        )
        self.assertEqual(role_response.status_code, 200)
        grant_response = self.client.post(
            f"/assistant/api/users/{self.user.pk}/enterprises/grant",
            data=json.dumps({"enterpriseId": str(self.enterprise.public_id), "canViewSensitive": False}),
            content_type="application/json",
        )
        self.assertEqual(grant_response.status_code, 200)
        self.assertTrue(RoleAssignment.objects.filter(user=self.user, role="UNIT_USER", is_active=True).exists())

    def test_unit_user_cannot_manage_other_users(self):
        assign_role(user=self.user, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        self.client.force_login(self.user)
        response = self.client.get("/assistant/api/users")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "PERMISSION_DENIED")

    def test_invalid_enterprise_identifier_returns_structured_error(self):
        assign_role(user=self.admin, role=RoleAssignment.Role.SYSTEM_ADMIN, assigned_by=self.admin)
        self.client.force_login(self.admin)
        response = self.client.post(
            f"/assistant/api/users/{self.user.pk}/enterprises/grant",
            data=json.dumps({"enterpriseId": "not-a-uuid"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "INVALID_IDENTIFIER")


class GovernanceSetupAndAdminTests(TestCase):
    def test_first_run_setup_is_local_only_and_creates_system_admin(self):
        denied = self.client.get(reverse("assistant-setup"), REMOTE_ADDR="10.0.0.5")
        self.assertEqual(denied.status_code, 403)
        response = self.client.post(reverse("assistant-setup"), {
            "username": "first-admin", "display_name": "首次管理员", "employee_code": "ADMIN-001",
            "password": "Strong-Local-Password-123!",
        }, REMOTE_ADDR="127.0.0.1")
        self.assertRedirects(response, reverse("assistant-admin"))
        admin = get_user_model().objects.get(username="first-admin")
        self.assertTrue(RoleAssignment.objects.filter(user=admin, role=RoleAssignment.Role.SYSTEM_ADMIN, is_active=True).exists())
        self.assertRedirects(self.client.get(reverse("assistant-setup")), reverse("assistant-login"), fetch_redirect_response=False)

    def test_admin_can_create_separated_user_enterprise_and_grant(self):
        self.client.post(reverse("assistant-setup"), {
            "username": "first-admin", "display_name": "首次管理员", "employee_code": "ADMIN-001",
            "password": "Strong-Local-Password-123!",
        }, REMOTE_ADDR="127.0.0.1")
        enterprise_response = self.client.post(reverse("assistant-admin-action", args=["create-enterprise"]), {
            "code": "REAL-COMPANY-001", "name": "真实联调企业", "scope_type": EnterpriseScope.ScopeType.ENTERPRISE, "parent_id": "",
        })
        self.assertRedirects(enterprise_response, reverse("assistant-admin"))
        user_response = self.client.post(reverse("assistant-admin-action", args=["create-user"]), {
            "username": "monitor-real", "display_name": "监控人员", "employee_code": "MON-001",
            "password": "Strong-Monitor-Password-123!", "role": RoleAssignment.Role.UNIT_USER,
        })
        self.assertRedirects(user_response, reverse("assistant-admin"))
        monitor = get_user_model().objects.get(username="monitor-real")
        enterprise = EnterpriseScope.objects.get(code="REAL-COMPANY-001")
        grant_response = self.client.post(reverse("assistant-admin-action", args=["grant-enterprise"]), {
            "user_id": monitor.pk, "enterprise_id": str(enterprise.public_id), "can_view_sensitive": "on",
        })
        self.assertRedirects(grant_response, reverse("assistant-admin"))
        self.assertTrue(EnterpriseGrant.objects.filter(user=monitor, enterprise=enterprise, can_view_sensitive=True).exists())


class SessionKeepaliveGovernanceTests(TestCase):
    def setUp(self):
        users = get_user_model()
        self.admin = users.objects.create_user(username="keepalive-admin")
        self.operator = users.objects.create_user(username="keepalive-operator")
        AssistantProfile.objects.create(user=self.admin, display_name="保活管理员", employee_code="KEEP-ADMIN")
        AssistantProfile.objects.create(user=self.operator, display_name="保活值班员", employee_code="KEEP-USER")
        assign_role(user=self.admin, role=RoleAssignment.Role.SYSTEM_ADMIN, assigned_by=self.admin)
        assign_role(user=self.operator, role=RoleAssignment.Role.UNIT_USER, assigned_by=self.admin)
        claim_shift(user=self.operator, platform_account_ref="platform-ref-keepalive", workstation_id="KEEP-DEVICE")

    def post_action_json(self, url, payload):
        token = self.client.get(reverse("assistant-action-token-api")).json()["data"]["actionToken"]
        return self.client.post(url, data=json.dumps(payload), content_type="application/json", HTTP_X_ASSISTANT_ACTION_TOKEN=token)

    def test_admin_updates_fixed_policy_and_unit_user_can_read(self):
        self.client.force_login(self.admin)
        response = self.post_action_json(reverse("assistant-session-keepalive-policy-api"), {"enabled": True, "intervalMinutes": 30})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["targetRoute"], SessionKeepalivePolicy.TARGET_ROUTE)
        targets = response.json()["data"]["allowedTargets"]
        self.assertEqual([target["route"] for target in targets], [
            "#/alarm-center/alarm-preprocessing",
            "#/vehicle-monitor/real-time",
            "#/alarm-center/pr-alarm-recorde",
        ])
        self.assertEqual(targets[0]["mode"], "CLICK_QUERY")
        self.assertTrue(all(target["mode"] == "READ_ONLY_OBSERVE" for target in targets[1:]))
        self.client.force_login(self.operator)
        read = self.client.get(reverse("assistant-session-keepalive-policy-api"))
        self.assertEqual(read.status_code, 200)
        self.assertTrue(read.json()["data"]["enabled"])
        self.assertIn("session.keepalive.execute", read.json() and services.permissions_for_roles([RoleAssignment.Role.UNIT_USER]))

    def test_unit_user_cannot_change_policy_or_submit_sensitive_audit(self):
        self.client.force_login(self.operator)
        denied = self.post_action_json(reverse("assistant-session-keepalive-policy-api"), {"enabled": True, "intervalMinutes": 30})
        self.assertEqual(denied.status_code, 403)
        heartbeat = self.post_action_json(reverse("assistant-device-heartbeat-api"), {
            "deviceId": "device-keepalive-1", "extensionVersion": "0.4.0", "platformAccountRef": "platform-ref-keepalive",
            "sessionStatus": "AUTHENTICATED", "route": SessionKeepalivePolicy.TARGET_ROUTE,
        })
        self.assertEqual(heartbeat.status_code, 200)
        rejected = self.post_action_json(reverse("assistant-session-keepalive-audit-api"), {
            "deviceId": "device-keepalive-1", "policyVersion": 1, "attemptedAt": timezone.now().isoformat(),
            "route": SessionKeepalivePolicy.TARGET_ROUTE, "resultCode": "SUCCESS", "latencyMs": 12,
            "vehicleNo": "不允许进入审计",
        })
        self.assertEqual(rejected.status_code, 422)
        self.assertEqual(SessionKeepaliveAudit.objects.count(), 0)

    def test_registered_device_accepts_sanitized_keepalive_audit(self):
        self.client.force_login(self.operator)
        self.post_action_json(reverse("assistant-device-heartbeat-api"), {
            "deviceId": "device-keepalive-2", "extensionVersion": "0.4.0", "platformAccountRef": "platform-ref-keepalive",
            "sessionStatus": "AUTHENTICATED", "route": SessionKeepalivePolicy.TARGET_ROUTE + "?page=2",
        })
        response = self.post_action_json(reverse("assistant-session-keepalive-audit-api"), {
            "deviceId": "device-keepalive-2", "policyVersion": 1, "attemptedAt": timezone.now().isoformat(),
            "route": SessionKeepalivePolicy.TARGET_ROUTE, "resultCode": "SUCCESS", "latencyMs": 10,
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(DeviceRegistration.objects.count(), 1)
        self.assertEqual(DeviceRegistration.objects.get().last_route, SessionKeepalivePolicy.TARGET_ROUTE)
        self.assertEqual(SessionKeepaliveAudit.objects.get().result_code, "SUCCESS")

    def test_device_heartbeat_keeps_platform_identity_context_separate(self):
        self.client.force_login(self.operator)
        response = self.post_action_json(reverse("assistant-device-heartbeat-api"), {
            "deviceId": "device-platform-context", "extensionVersion": "0.5.3",
            "platformAccountRef": "platform-ref-keepalive", "sessionStatus": "AUTHENTICATED",
            "route": "#/vehicle-monitor/real-time", "platformContext": {
                "displayName": "省平台显示姓名", "identityStatus": "UNVERIFIED",
                "visibleScopeHash": "a" * 64, "permissionSummary": {"alarm.read": True},
            },
        })
        self.assertEqual(response.status_code, 200)
        device = DeviceRegistration.objects.get(device_id="device-platform-context")
        self.assertEqual(device.platform_display_name, "省平台显示姓名")
        self.assertEqual(device.platform_identity_status, "UNVERIFIED")
        self.assertEqual(device.platform_visible_scope_hash, "a" * 64)
        self.assertEqual(device.platform_permission_summary, {"alarm.read": True})

    def test_fresh_device_registration_blocks_second_device(self):
        self.client.force_login(self.operator)
        payload = {
            "extensionVersion": "0.6.0", "platformAccountRef": "platform-ref-keepalive",
            "sessionStatus": "AUTHENTICATED", "route": "#/vehicle-monitor/real-time",
        }
        self.assertEqual(self.post_action_json(reverse("assistant-device-heartbeat-api"), {**payload, "deviceId": "fresh-device-one"}).status_code, 200)
        blocked = self.post_action_json(reverse("assistant-device-heartbeat-api"), {**payload, "deviceId": "fresh-device-two"})
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json()["code"], "PLATFORM_ACCOUNT_DEVICE_CONFLICT")
        self.assertEqual(DeviceRegistration.objects.filter(is_active=True).count(), 1)

    def test_stale_same_user_device_without_actions_is_replaced(self):
        self.client.force_login(self.operator)
        payload = {
            "extensionVersion": "0.6.0", "platformAccountRef": "platform-ref-keepalive",
            "sessionStatus": "AUTHENTICATED", "route": "#/vehicle-monitor/real-time",
        }
        self.assertEqual(self.post_action_json(reverse("assistant-device-heartbeat-api"), {**payload, "deviceId": "stale-device-one"}).status_code, 200)
        DeviceRegistration.objects.filter(device_id="stale-device-one").update(last_seen_at=timezone.now() - timedelta(minutes=3))
        replaced = self.post_action_json(reverse("assistant-device-heartbeat-api"), {**payload, "deviceId": "replacement-device-two"})
        self.assertEqual(replaced.status_code, 200)
        self.assertFalse(DeviceRegistration.objects.get(device_id="stale-device-one").is_active)
        self.assertTrue(DeviceRegistration.objects.get(device_id="replacement-device-two").is_active)
        self.assertTrue(AuditEvent.objects.filter(event_type="STALE_DEVICE_REGISTRATION_REPLACED").exists())

    def test_stale_device_with_unfinished_action_cannot_be_replaced(self):
        self.client.force_login(self.operator)
        payload = {
            "extensionVersion": "0.6.0", "platformAccountRef": "platform-ref-keepalive",
            "sessionStatus": "AUTHENTICATED", "route": "#/vehicle-monitor/real-time",
        }
        self.assertEqual(self.post_action_json(reverse("assistant-device-heartbeat-api"), {**payload, "deviceId": "busy-stale-device"}).status_code, 200)
        DeviceRegistration.objects.filter(device_id="busy-stale-device").update(last_seen_at=timezone.now() - timedelta(minutes=3))
        with patch("apps.reporting.models.ActionLease.objects.filter") as action_filter:
            action_filter.return_value.exists.return_value = True
            blocked = self.post_action_json(reverse("assistant-device-heartbeat-api"), {**payload, "deviceId": "blocked-replacement"})
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json()["code"], "PLATFORM_ACCOUNT_DEVICE_CONFLICT")
        self.assertTrue(DeviceRegistration.objects.get(device_id="busy-stale-device").is_active)

    def test_operator_explicitly_verifies_matching_realtime_platform_context(self):
        RoleAssignment.objects.filter(user=self.operator, is_active=True).update(is_active=False)
        assign_role(user=self.operator, role=RoleAssignment.Role.MONITOR_OPERATOR, assigned_by=self.admin)
        self.client.force_login(self.operator)
        heartbeat = self.post_action_json(reverse("assistant-device-heartbeat-api"), {
            "deviceId": "device-platform-action", "extensionVersion": "0.6.0",
            "platformAccountRef": "platform-ref-keepalive", "sessionStatus": "AUTHENTICATED",
            "route": "#/vehicle-monitor/real-time", "platformContext": {
                "displayName": "省平台值班身份", "identityStatus": "UNVERIFIED",
                "visibleScopeHash": "b" * 64, "permissionSummary": {"alarm.read": True},
            },
        })
        self.assertEqual(heartbeat.status_code, 200)
        verified = self.post_action_json(reverse("assistant-device-verify-platform-action-api"), {
            "deviceId": "device-platform-action",
            "platformDisplayName": "省平台值班身份",
            "route": "#/vehicle-monitor/real-time",
        })
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.json()["data"]["platformIdentityStatus"], "VERIFIED")
        self.assertEqual(
            DeviceRegistration.objects.get(device_id="device-platform-action").platform_identity_status,
            "VERIFIED",
        )

    def test_platform_action_context_rejects_identity_mismatch(self):
        RoleAssignment.objects.filter(user=self.operator, is_active=True).update(is_active=False)
        assign_role(user=self.operator, role=RoleAssignment.Role.MONITOR_OPERATOR, assigned_by=self.admin)
        self.client.force_login(self.operator)
        self.post_action_json(reverse("assistant-device-heartbeat-api"), {
            "deviceId": "device-platform-mismatch", "extensionVersion": "0.6.0",
            "platformAccountRef": "platform-ref-keepalive", "sessionStatus": "AUTHENTICATED",
            "route": "#/vehicle-monitor/real-time", "platformContext": {
                "displayName": "省平台值班身份", "identityStatus": "UNVERIFIED",
                "visibleScopeHash": "c" * 64, "permissionSummary": {"alarm.read": True},
            },
        })
        rejected = self.post_action_json(reverse("assistant-device-verify-platform-action-api"), {
            "deviceId": "device-platform-mismatch",
            "platformDisplayName": "其他身份",
            "route": "#/vehicle-monitor/real-time",
        })
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["code"], "PLATFORM_IDENTITY_MISMATCH")

    def test_platform_action_context_rejects_stale_device_heartbeat(self):
        RoleAssignment.objects.filter(user=self.operator, is_active=True).update(is_active=False)
        assign_role(user=self.operator, role=RoleAssignment.Role.MONITOR_OPERATOR, assigned_by=self.admin)
        self.client.force_login(self.operator)
        self.post_action_json(reverse("assistant-device-heartbeat-api"), {
            "deviceId": "device-platform-stale", "extensionVersion": "0.6.0",
            "platformAccountRef": "platform-ref-keepalive", "sessionStatus": "AUTHENTICATED",
            "route": "#/vehicle-monitor/real-time", "platformContext": {
                "displayName": "省平台值班身份", "identityStatus": "UNVERIFIED",
                "visibleScopeHash": "d" * 64, "permissionSummary": {"alarm.read": True},
            },
        })
        DeviceRegistration.objects.filter(device_id="device-platform-stale").update(
            last_seen_at=timezone.now() - timedelta(minutes=3),
        )
        rejected = self.post_action_json(reverse("assistant-device-verify-platform-action-api"), {
            "deviceId": "device-platform-stale",
            "platformDisplayName": "省平台值班身份",
            "route": "#/vehicle-monitor/real-time",
        })
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["code"], "DEVICE_HEARTBEAT_STALE")

    def test_device_heartbeat_rejects_raw_platform_identity_fields(self):
        self.client.force_login(self.operator)
        response = self.post_action_json(reverse("assistant-device-heartbeat-api"), {
            "deviceId": "device-platform-context-invalid", "extensionVersion": "0.5.3",
            "platformAccountRef": "platform-ref-keepalive", "sessionStatus": "AUTHENTICATED",
            "route": "#/vehicle-monitor/real-time", "platformContext": {"cookie": "must-not-cross"},
        })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["code"], "INVALID_PLATFORM_CONTEXT")

    def test_extension_endpoints_require_action_token_but_not_browser_csrf_origin(self):
        browser_client = Client(enforce_csrf_checks=True)
        browser_client.force_login(self.operator)
        token = browser_client.get(reverse("assistant-action-token-api")).json()["data"]["actionToken"]
        heartbeat = browser_client.post(
            reverse("assistant-device-heartbeat-api"),
            data=json.dumps({
                "deviceId": "device-csrf-boundary", "extensionVersion": "0.4.0",
                "platformAccountRef": "platform-ref-keepalive", "sessionStatus": "AUTHENTICATED",
                "route": SessionKeepalivePolicy.TARGET_ROUTE,
            }), content_type="application/json", HTTP_X_ASSISTANT_ACTION_TOKEN=token,
            HTTP_ORIGIN="chrome-extension://synthetic-extension-id",
        )
        self.assertEqual(heartbeat.status_code, 200)
        missing_token = browser_client.post(
            reverse("assistant-device-heartbeat-api"), data="{}", content_type="application/json",
            HTTP_ORIGIN="chrome-extension://synthetic-extension-id",
        )
        self.assertEqual(missing_token.status_code, 403)
        browser_client.logout()
        login_without_csrf = browser_client.post(reverse("assistant-login"), {"username": "x", "password": "x"})
        self.assertEqual(login_without_csrf.status_code, 403)

    def test_voice_interaction_policy_defaults_closed_and_admin_can_update(self):
        self.client.force_login(self.operator)
        read = self.client.get(reverse("assistant-voice-interaction-policy-api"))
        self.assertEqual(read.status_code, 200)
        self.assertFalse(read.json()["data"]["enabled"])
        denied = self.post_action_json(reverse("assistant-voice-interaction-policy-api"), {
            "enabled": True, "recordDriverAudio": True, "transcribeDriverAudio": True, "retentionDays": 7,
        })
        self.assertEqual(denied.status_code, 403)
        self.client.force_login(self.admin)
        updated = self.post_action_json(reverse("assistant-voice-interaction-policy-api"), {
            "enabled": True, "recordDriverAudio": True, "transcribeDriverAudio": True, "retentionDays": 14,
        })
        self.assertEqual(updated.status_code, 200)
        policy = VoiceInteractionPolicy.objects.get()
        self.assertTrue(policy.record_driver_audio)
        self.assertEqual(policy.retention_days, 14)

    def test_voice_interaction_policy_cannot_enable_recording_without_policy(self):
        self.client.force_login(self.admin)
        response = self.post_action_json(reverse("assistant-voice-interaction-policy-api"), {
            "enabled": False, "recordDriverAudio": True, "transcribeDriverAudio": False, "retentionDays": 7,
        })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["code"], "INVALID_VOICE_POLICY")
