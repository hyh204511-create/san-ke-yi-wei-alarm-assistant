import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from apps.governance.models import TimeStampedModel
from apps.governance.encrypted_fields import EncryptedJSONField


class DisposalCase(TimeStampedModel):
    class Status(models.TextChoices):
        MANUAL_REQUIRED = "MANUAL_REQUIRED", "待人工接管"
        IN_MANUAL = "IN_MANUAL", "人工处理中"
        PENDING_REVIEW = "PENDING_REVIEW", "待复核"
        COMPLETED = "COMPLETED", "已完成"
        REOPENED = "REOPENED", "已重开"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    event_id = models.CharField(max_length=160, unique=True)
    alarm_id = models.CharField(max_length=160, blank=True, default="")
    enterprise = models.ForeignKey("governance.EnterpriseScope", on_delete=models.PROTECT, related_name="disposal_cases")
    source_kind = models.CharField(max_length=30, db_index=True)
    alarm_name = models.CharField(max_length=200, blank=True, default="")
    vehicle_no = models.CharField(max_length=100, blank=True, default="")
    event_snapshot = EncryptedJSONField(default=dict)
    latest_event_snapshot = EncryptedJSONField(default=dict)
    decision_snapshot = EncryptedJSONField(default=dict)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.MANUAL_REQUIRED, db_index=True)
    requires_review = models.BooleanField(default=True)
    assigned_to = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="assigned_disposal_cases")
    taken_over_at = models.DateTimeField(null=True, blank=True)
    completed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="completed_disposal_cases")
    completed_at = models.DateTimeField(null=True, blank=True)
    resolution_code = models.CharField(max_length=80, blank=True, default="")
    resolution_note = models.CharField(max_length=1000, blank=True, default="")
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="reviewed_disposal_cases")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_comment = models.CharField(max_length=1000, blank=True, default="")
    version = models.PositiveIntegerField(default=1)

    class Meta:
        db_table = "assistant_disposal_cases"
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["enterprise", "status", "-updated_at"], name="disposal_scope_status_idx"),
            models.Index(fields=["assigned_to", "status"], name="disposal_assignee_status_idx"),
        ]


class DisposalEvent(models.Model):
    class Action(models.TextChoices):
        CREATED = "CREATED", "已创建"
        SNAPSHOT_UPDATED = "SNAPSHOT_UPDATED", "快照已更新"
        TAKEN_OVER = "TAKEN_OVER", "已接管"
        NOTE_ADDED = "NOTE_ADDED", "已备注"
        SUBMITTED_REVIEW = "SUBMITTED_REVIEW", "已提交复核"
        COMPLETED = "COMPLETED", "已完成"
        REVIEW_APPROVED = "REVIEW_APPROVED", "复核通过"
        REVIEW_REJECTED = "REVIEW_REJECTED", "复核退回"
        REOPENED = "REOPENED", "已重开"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    disposal_case = models.ForeignKey(DisposalCase, on_delete=models.PROTECT, related_name="events")
    action = models.CharField(max_length=30, choices=Action.choices, db_index=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="disposal_events")
    from_status = models.CharField(max_length=30, blank=True, default="")
    to_status = models.CharField(max_length=30, blank=True, default="")
    comment = models.CharField(max_length=1000, blank=True, default="")
    detail = EncryptedJSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "assistant_disposal_events"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["disposal_case", "created_at"], name="disposal_event_case_time_idx")]

    def save(self, *args, **kwargs):
        if self.pk:
            raise ValidationError("处置事件为追加式记录，不能原地修改")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("处置事件为审计记录，不能删除")
