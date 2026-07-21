import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


class ResponseAsset(models.Model):
    class ChannelType(models.TextChoices):
        TEXT = "TEXT", "固定文本"
        VOICE = "VOICE", "固定语音"

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "草稿"
        IN_REVIEW = "IN_REVIEW", "审核中"
        APPROVED = "APPROVED", "已批准"
        REJECTED = "REJECTED", "已驳回"
        PUBLISHED = "PUBLISHED", "已发布"
        RETIRED = "RETIRED", "已退役"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    asset_key = models.CharField(max_length=100)
    version = models.CharField(max_length=100)
    channel_type = models.CharField(max_length=10, choices=ChannelType.choices)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT, db_index=True)
    enterprise_scopes = models.ManyToManyField("governance.EnterpriseScope", related_name="response_assets")
    text_template = models.TextField(blank=True, default="")
    voice_bytes = models.BinaryField(blank=True, default=bytes)
    voice_filename = models.CharField(max_length=255, blank=True, default="")
    voice_mime_type = models.CharField(max_length=100, blank=True, default="")
    sample_rate = models.PositiveIntegerField(null=True, blank=True)
    channels = models.PositiveSmallIntegerField(null=True, blank=True)
    bits_per_sample = models.PositiveSmallIntegerField(null=True, blank=True)
    duration_ms = models.PositiveIntegerField(null=True, blank=True)
    content_hash = models.CharField(max_length=64, db_index=True)
    change_note = models.CharField(max_length=500)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_response_assets")
    submitted_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="reviewed_response_assets")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_comment = models.CharField(max_length=1000, blank=True, default="")
    published_at = models.DateTimeField(null=True, blank=True, db_index=True)
    retired_at = models.DateTimeField(null=True, blank=True)
    based_on = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="derived_assets")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "assistant_response_assets"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["asset_key", "version"], name="unique_response_asset_version"),
            models.UniqueConstraint(fields=["asset_key"], condition=Q(status="PUBLISHED"), name="unique_published_response_asset_key"),
        ]
        indexes = [
            models.Index(fields=["channel_type", "status", "-created_at"], name="response_asset_type_status_idx"),
            models.Index(fields=["asset_key", "status"], name="response_asset_key_status_idx"),
        ]


class ResponseAssetEvent(models.Model):
    class Action(models.TextChoices):
        CREATED = "CREATED", "已创建"
        UPDATED = "UPDATED", "已更新"
        SUBMITTED = "SUBMITTED", "已提交"
        APPROVED = "APPROVED", "已批准"
        REJECTED = "REJECTED", "已驳回"
        PUBLISHED = "PUBLISHED", "已发布"
        RETIRED = "RETIRED", "已退役"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    asset = models.ForeignKey(ResponseAsset, on_delete=models.PROTECT, related_name="events")
    action = models.CharField(max_length=20, choices=Action.choices, db_index=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="response_asset_events")
    comment = models.CharField(max_length=1000, blank=True, default="")
    content_hash_snapshot = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "assistant_response_asset_events"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["asset", "created_at"], name="response_asset_event_time_idx")]

    def save(self, *args, **kwargs):
        if self.pk:
            raise ValidationError("响应资产事件为追加式记录，不能原地修改")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("响应资产事件为审计记录，不能删除")
