import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.core.validators import MaxValueValidator, MinValueValidator
from django.utils import timezone

from .encrypted_fields import EncryptedJSONField


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class EnterpriseScope(TimeStampedModel):
    class ScopeType(models.TextChoices):
        GROUP = "GROUP", "集团"
        BRANCH = "BRANCH", "分公司"
        ENTERPRISE = "ENTERPRISE", "企业"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    code = models.CharField(max_length=100, unique=True)
    name = models.CharField(max_length=200)
    scope_type = models.CharField(max_length=20, choices=ScopeType.choices)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "assistant_enterprise_scopes"
        ordering = ["code"]


class AssistantProfile(TimeStampedModel):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="assistant_profile")
    display_name = models.CharField(max_length=100)
    employee_code = models.CharField(max_length=100, unique=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "assistant_profiles"


class RoleAssignment(TimeStampedModel):
    class Role(models.TextChoices):
        UNIT_USER = "UNIT_USER", "单位使用人员"
        RULE_CONFIGURER = "RULE_CONFIGURER", "规则配置员"
        RULE_REVIEWER = "RULE_REVIEWER", "规则审核员"
        SYSTEM_ADMIN = "SYSTEM_ADMIN", "系统管理员"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="assistant_roles")
    role = models.CharField(max_length=32, choices=Role.choices)
    assigned_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="assigned_assistant_roles")
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "assistant_role_assignments"
        constraints = [models.UniqueConstraint(fields=["user", "role"], name="unique_assistant_user_role")]
        indexes = [models.Index(fields=["user", "is_active"], name="assistant_role_user_active_idx")]


class EnterpriseGrant(TimeStampedModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="assistant_enterprise_grants")
    enterprise = models.ForeignKey(EnterpriseScope, on_delete=models.PROTECT, related_name="user_grants")
    can_view_sensitive = models.BooleanField(default=False)

    class Meta:
        db_table = "assistant_enterprise_grants"
        constraints = [models.UniqueConstraint(fields=["user", "enterprise"], name="unique_assistant_user_enterprise")]
        indexes = [models.Index(fields=["user", "enterprise"], name="assistant_grant_user_scope_idx")]


class DutyShift(TimeStampedModel):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="assistant_duty_shifts")
    platform_account_ref = models.CharField(max_length=120)
    workstation_id = models.CharField(max_length=120)
    role_snapshot = models.JSONField(default=list)
    enterprise_scope_snapshot = models.JSONField(default=list)
    started_at = models.DateTimeField(default=timezone.now, db_index=True)
    ended_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        db_table = "assistant_duty_shifts"
        ordering = ["-started_at"]
        constraints = [
            models.UniqueConstraint(fields=["user"], condition=Q(ended_at__isnull=True), name="unique_active_shift_per_user"),
            models.UniqueConstraint(fields=["workstation_id"], condition=Q(ended_at__isnull=True), name="unique_active_shift_per_workstation"),
            models.UniqueConstraint(fields=["platform_account_ref"], condition=Q(ended_at__isnull=True), name="unique_active_shift_per_platform_account"),
        ]
        indexes = [models.Index(fields=["platform_account_ref", "-started_at"], name="assistant_shift_platform_idx")]


class DeviceRegistration(TimeStampedModel):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    device_id = models.CharField(max_length=120, unique=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="assistant_devices")
    platform_account_ref = models.CharField(max_length=120, blank=True, default="")
    platform_display_name = models.CharField(max_length=100, blank=True, default="")
    platform_identity_status = models.CharField(max_length=20, blank=True, default="UNKNOWN")
    platform_visible_scope_hash = models.CharField(max_length=64, blank=True, default="")
    platform_permission_summary = EncryptedJSONField(default=dict)
    platform_identity_observed_at = models.DateTimeField(null=True, blank=True)
    extension_version = models.CharField(max_length=40, blank=True, default="")
    session_status = models.CharField(max_length=40, blank=True, default="UNKNOWN")
    last_route = models.CharField(max_length=200, blank=True, default="")
    last_seen_at = models.DateTimeField(default=timezone.now, db_index=True)
    is_active = models.BooleanField(default=True, db_index=True)

    class Meta:
        db_table = "assistant_device_registrations"
        constraints = [
            models.UniqueConstraint(
                fields=["platform_account_ref"],
                condition=Q(is_active=True, platform_account_ref__gt=""),
                name="unique_active_platform_device",
            ),
        ]
        indexes = [models.Index(fields=["user", "is_active", "-last_seen_at"], name="assistant_device_user_seen_idx")]


class SessionKeepalivePolicy(TimeStampedModel):
    SINGLETON_KEY = "PROVINCIAL_PLATFORM"
    TARGET_ROUTE = "#/alarm-center/alarm-preprocessing"
    TARGET_ACTION_KEY = "ALARM_PREPROCESSING_QUERY"

    key = models.CharField(max_length=40, unique=True, default=SINGLETON_KEY, editable=False)
    enabled = models.BooleanField(default=False)
    interval_minutes = models.PositiveSmallIntegerField(
        default=30, validators=[MinValueValidator(20), MaxValueValidator(50)]
    )
    target_route = models.CharField(max_length=160, default=TARGET_ROUTE, editable=False)
    target_action_key = models.CharField(max_length=80, default=TARGET_ACTION_KEY, editable=False)
    version = models.PositiveIntegerField(default=1)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT,
        related_name="updated_session_keepalive_policies",
    )

    class Meta:
        db_table = "assistant_session_keepalive_policies"


class VoiceInteractionPolicy(TimeStampedModel):
    SINGLETON_KEY = "PROVINCIAL_PLATFORM_VOICE"

    key = models.CharField(max_length=50, unique=True, default=SINGLETON_KEY, editable=False)
    enabled = models.BooleanField(default=False)
    record_driver_audio = models.BooleanField(default=False)
    transcribe_driver_audio = models.BooleanField(default=False)
    consent_required = models.BooleanField(default=True, editable=False)
    retention_days = models.PositiveSmallIntegerField(default=7, validators=[MinValueValidator(1), MaxValueValidator(365)])
    version = models.PositiveIntegerField(default=1)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT,
        related_name="updated_voice_interaction_policies",
    )

    class Meta:
        db_table = "assistant_voice_interaction_policies"


class SessionKeepaliveAudit(models.Model):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="session_keepalive_audits")
    device = models.ForeignKey(DeviceRegistration, on_delete=models.PROTECT, related_name="keepalive_audits")
    policy_version = models.PositiveIntegerField()
    route = models.CharField(max_length=200, blank=True, default="")
    result_code = models.CharField(max_length=40, db_index=True)
    latency_ms = models.PositiveIntegerField(default=0)
    attempted_at = models.DateTimeField(db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "assistant_session_keepalive_audits"
        indexes = [models.Index(fields=["device", "-attempted_at"], name="assistant_keepalive_device_idx")]


class AuditEvent(models.Model):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="assistant_audit_events")
    event_type = models.CharField(max_length=80, db_index=True)
    object_type = models.CharField(max_length=80)
    object_id = models.CharField(max_length=200)
    role_snapshot = models.JSONField(default=list)
    enterprise_scope_snapshot = models.JSONField(default=list)
    detail = models.JSONField(default=dict)
    request_id = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "assistant_audit_events"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["object_type", "object_id", "-created_at"], name="assistant_audit_object_idx")]
