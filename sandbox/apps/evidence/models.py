import uuid

from django.conf import settings
from django.db import models

from apps.governance.encrypted_fields import EncryptedJSONField
from apps.governance.models import TimeStampedModel


class EvidenceRequest(TimeStampedModel):
    class Status(models.TextChoices):
        PENDING = "PENDING", "待审批"
        REJECTED = "REJECTED", "已驳回"
        READY = "READY", "加密包可下载"
        EXPIRED = "EXPIRED", "已过期"
        DELETED = "DELETED", "已删除"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    enterprise = models.ForeignKey("governance.EnterpriseScope", on_delete=models.PROTECT, related_name="evidence_requests")
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="requested_evidence_packages")
    purpose = models.CharField(max_length=500)
    event_ids = EncryptedJSONField(default=list)
    requested_fields = EncryptedJSONField(default=list)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="reviewed_evidence_packages")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_comment = models.CharField(max_length=1000, blank=True, default="")
    file_name = models.CharField(max_length=255, blank=True, default="")
    file_path = models.CharField(max_length=500, blank=True, default="")
    file_sha256 = models.CharField(max_length=64, blank=True, default="")
    file_size = models.PositiveBigIntegerField(default=0)
    encryption_algorithm = models.CharField(max_length=50, blank=True, default="")
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    download_count = models.PositiveIntegerField(default=0)
    last_downloaded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "assistant_evidence_requests"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["enterprise", "status", "-created_at"], name="evidence_scope_status_idx"),
            models.Index(fields=["requested_by", "status"], name="evidence_requester_status_idx"),
        ]

