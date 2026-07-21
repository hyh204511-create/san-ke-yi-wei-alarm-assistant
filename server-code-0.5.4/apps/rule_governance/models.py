import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class RulePackage(models.Model):
    class Status(models.TextChoices):
        DRAFT = "DRAFT", "草稿"
        IN_REVIEW = "IN_REVIEW", "审核中"
        APPROVED = "APPROVED", "已批准"
        REJECTED = "REJECTED", "已驳回"
        PUBLISHED = "PUBLISHED", "已发布"
        RETIRED = "RETIRED", "已退役"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    version = models.CharField(max_length=100, unique=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT, db_index=True)
    payload = models.JSONField(default=dict)
    content_hash = models.CharField(max_length=64, blank=True, default="", db_index=True)
    change_note = models.CharField(max_length=500)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_rule_packages")
    submitted_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="reviewed_rule_packages")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_comment = models.CharField(max_length=1000, blank=True, default="")
    published_at = models.DateTimeField(null=True, blank=True, db_index=True)
    retired_at = models.DateTimeField(null=True, blank=True)
    based_on = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="derived_versions")
    rollback_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="rollback_versions")
    enterprise_scopes = models.ManyToManyField("governance.EnterpriseScope", blank=True, related_name="rule_packages")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "assistant_rule_packages"
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["status"], condition=Q(status="PUBLISHED"), name="unique_published_rule_pkg")]
        indexes = [
            models.Index(fields=["status", "-created_at"], name="rule_pkg_status_created_idx"),
            models.Index(fields=["-published_at"], name="rule_pkg_published_idx"),
        ]


class RuleReviewEvent(models.Model):
    class Action(models.TextChoices):
        CREATED = "CREATED", "已创建"
        UPDATED = "UPDATED", "已更新"
        SUBMITTED = "SUBMITTED", "已提交"
        APPROVED = "APPROVED", "已批准"
        REJECTED = "REJECTED", "已驳回"
        PUBLISHED = "PUBLISHED", "已发布"
        RETIRED = "RETIRED", "已退役"
        ROLLED_BACK = "ROLLED_BACK", "已回滚"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    rule_package = models.ForeignKey(RulePackage, on_delete=models.PROTECT, related_name="review_events")
    action = models.CharField(max_length=20, choices=Action.choices, db_index=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="rule_review_events")
    comment = models.CharField(max_length=1000, blank=True, default="")
    content_hash_snapshot = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "assistant_rule_review_events"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["rule_package", "created_at"], name="rule_review_pkg_time_idx")]
