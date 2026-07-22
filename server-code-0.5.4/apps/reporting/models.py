import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.governance.models import TimeStampedModel
from apps.governance.encrypted_fields import EncryptedJSONField


class AlarmFact(TimeStampedModel):
    class ProcessingStatus(models.TextChoices):
        UNPROCESSED = "UNPROCESSED", "未处理"
        EXECUTING = "EXECUTING", "处理中"
        PROCESSED = "PROCESSED", "已处理"
        MANUAL_REQUIRED = "MANUAL_REQUIRED", "待人工处理"
        UNKNOWN = "UNKNOWN", "处理结果未知"

    event_id = models.CharField(max_length=160, unique=True)
    business_fingerprint = models.CharField(max_length=64, unique=True, null=True, blank=True)
    alarm_id = models.CharField(max_length=160, blank=True, default="")
    enterprise = models.ForeignKey("governance.EnterpriseScope", on_delete=models.PROTECT, related_name="alarm_facts")
    company_name_snapshot = models.CharField(max_length=200)
    source_kind = models.CharField(max_length=30, db_index=True)
    alarm_name = models.CharField(max_length=200, blank=True, default="", db_index=True)
    alarm_time = models.DateTimeField(null=True, blank=True, db_index=True)
    vehicle_id = models.CharField(max_length=160, blank=True, default="")
    vehicle_no = models.CharField(max_length=100, blank=True, default="")
    final_state = models.CharField(max_length=40, blank=True, default="", db_index=True)
    completion_status = models.CharField(max_length=30, blank=True, default="UNKNOWN_MANUAL", db_index=True)
    completion_source = models.CharField(max_length=30, blank=True, default="MANUAL_CONFIRMATION")
    completion_manual_required = models.BooleanField(default=True, db_index=True)
    completion_reason = models.CharField(max_length=500, blank=True, default="")
    processing_status = models.CharField(max_length=30, choices=ProcessingStatus.choices, default=ProcessingStatus.UNPROCESSED, db_index=True)
    processing_source = models.CharField(max_length=40, blank=True, default="")
    processing_marked_at = models.DateTimeField(null=True, blank=True)
    event_snapshot = EncryptedJSONField(default=dict)
    decision_snapshot = EncryptedJSONField(default=dict)
    action_snapshot = EncryptedJSONField(default=dict)
    ingestion_provenance = EncryptedJSONField(default=list)
    first_seen_at = models.DateTimeField(db_index=True)
    last_seen_at = models.DateTimeField(db_index=True)
    ingested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="ingested_alarm_facts")

    class Meta:
        db_table = "assistant_alarm_facts"
        ordering = ["-alarm_time", "-last_seen_at"]
        indexes = [
            models.Index(fields=["enterprise", "alarm_time"], name="alarm_fact_scope_time_idx"),
            models.Index(fields=["enterprise", "source_kind", "alarm_time"], name="alarm_fact_source_time_idx"),
            models.Index(fields=["source_kind", "final_state", "-last_seen_at"], name="alarm_fact_state_seen_idx"),
        ]


class CaptureSource(models.Model):
    fact = models.ForeignKey(AlarmFact, on_delete=models.CASCADE, related_name="capture_sources")
    capture_id = models.CharField(max_length=160)
    device_id = models.CharField(max_length=120)
    platform_account_ref = models.CharField(max_length=120)
    extension_version = models.CharField(max_length=40, blank=True, default="")
    endpoint = models.CharField(max_length=300, blank=True, default="")
    captured_at = models.DateTimeField(db_index=True)
    ingested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="alarm_capture_sources")
    payload_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "assistant_alarm_capture_sources"
        constraints = [models.UniqueConstraint(fields=["device_id", "capture_id"], name="unique_device_capture")]
        indexes = [
            models.Index(fields=["fact", "-captured_at"], name="alarm_capture_fact_time_idx"),
            models.Index(fields=["device_id", "-captured_at"], name="alarm_capture_device_time_idx"),
        ]


class ActionLease(TimeStampedModel):
    class Status(models.TextChoices):
        ACTIVE = "ACTIVE", "有效"
        EXECUTING = "EXECUTING", "执行中"
        COMPLETED = "COMPLETED", "已完成"
        FAILED = "FAILED", "明确失败"
        BLOCKED = "BLOCKED", "被阻断"
        MANUAL_REQUIRED = "MANUAL_REQUIRED", "转人工"
        EXPIRED = "EXPIRED", "已过期"
        UNKNOWN = "UNKNOWN", "结果未知"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    fact = models.ForeignKey(AlarmFact, on_delete=models.PROTECT, related_name="action_leases")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="alarm_action_leases")
    device_id = models.CharField(max_length=120)
    action_type = models.CharField(max_length=60)
    action_scope_key = models.CharField(max_length=64, blank=True, default="", db_index=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE, db_index=True)
    lease_token_hash = models.CharField(max_length=64, unique=True, null=True, blank=True, default=None)
    result_code = models.CharField(max_length=30, blank=True, default="")
    result_payload = EncryptedJSONField(default=dict)
    started_at = models.DateTimeField(null=True, blank=True)
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(db_index=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "assistant_action_leases"
        constraints = [
            models.UniqueConstraint(
                fields=["fact"],
                condition=Q(status__in=["ACTIVE", "EXECUTING"]),
                name="unique_active_fact_plan_lease",
            ),
            models.UniqueConstraint(
                fields=["action_scope_key"],
                condition=Q(status__in=["ACTIVE", "EXECUTING"]) & ~Q(action_scope_key=""),
                name="unique_active_vehicle_alarm_scope",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "expires_at"], name="action_lease_status_expiry_idx"),
            models.Index(fields=["action_scope_key", "-created_at"], name="action_scope_recent_idx"),
        ]


class DutyNotification(TimeStampedModel):
    class Status(models.TextChoices):
        UNREAD = "UNREAD", "未读"
        ACKNOWLEDGED = "ACKNOWLEDGED", "已确认"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="duty_notifications")
    enterprise = models.ForeignKey("governance.EnterpriseScope", on_delete=models.PROTECT, related_name="duty_notifications")
    action_lease = models.ForeignKey(ActionLease, null=True, blank=True, on_delete=models.PROTECT, related_name="notifications")
    event_id = models.CharField(max_length=160, db_index=True)
    kind = models.CharField(max_length=40, db_index=True)
    result_code = models.CharField(max_length=30, blank=True, default="")
    title = models.CharField(max_length=200)
    message = models.CharField(max_length=1000)
    detail = EncryptedJSONField(default=dict)
    dedupe_key = models.CharField(max_length=128, unique=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.UNREAD, db_index=True)
    acknowledged_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="acknowledged_duty_notifications")
    acknowledged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "assistant_duty_notifications"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["recipient", "status", "-created_at"], name="duty_notice_recipient_idx"),
            models.Index(fields=["enterprise", "event_id", "-created_at"], name="duty_notice_event_idx"),
        ]


class VoiceInteractionEvidence(TimeStampedModel):
    class Status(models.TextChoices):
        CAPTURED = "CAPTURED", "已登记录音"
        TRANSCRIBED = "TRANSCRIBED", "已转文字"
        FAILED = "FAILED", "处理失败"
        EXPIRED = "EXPIRED", "已过期"

    class TranscriptionStatus(models.TextChoices):
        NOT_REQUESTED = "NOT_REQUESTED", "未请求转写"
        PENDING = "PENDING", "等待转写"
        READY = "READY", "转写完成"
        FAILED = "FAILED", "转写失败"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    fact = models.ForeignKey(AlarmFact, on_delete=models.PROTECT, related_name="voice_evidence")
    action_lease = models.ForeignKey(ActionLease, null=True, blank=True, on_delete=models.PROTECT, related_name="voice_evidence")
    enterprise = models.ForeignKey("governance.EnterpriseScope", on_delete=models.PROTECT, related_name="voice_interaction_evidence")
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="requested_voice_evidence")
    event_id = models.CharField(max_length=160, db_index=True)
    policy_version = models.PositiveIntegerField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CAPTURED, db_index=True)
    transcription_status = models.CharField(max_length=20, choices=TranscriptionStatus.choices, default=TranscriptionStatus.NOT_REQUESTED, db_index=True)
    audio_sha256 = models.CharField(max_length=64, blank=True, default="")
    audio_duration_ms = models.PositiveIntegerField(default=0)
    audio_metadata = EncryptedJSONField(default=dict)
    transcript = EncryptedJSONField(default=dict)
    transcript_engine = models.CharField(max_length=80, blank=True, default="")
    transcript_confidence = models.FloatField(null=True, blank=True)
    recorded_started_at = models.DateTimeField(null=True, blank=True)
    recorded_ended_at = models.DateTimeField(null=True, blank=True)
    retention_until = models.DateTimeField(db_index=True)
    dedupe_key = models.CharField(max_length=128, unique=True)

    class Meta:
        db_table = "assistant_voice_interaction_evidence"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["enterprise", "status", "-created_at"], name="voice_evidence_scope_idx"),
            models.Index(fields=["retention_until", "status"], name="voice_evidence_retention_idx"),
        ]


class ReportTask(TimeStampedModel):
    class ReportType(models.TextChoices):
        ALARM_DAILY = "ALARM_DAILY", "企业报警日报"
        ALARM_WEEKLY = "ALARM_WEEKLY", "企业报警周报"
        ALARM_MONTHLY = "ALARM_MONTHLY", "企业报警月报"
        VEHICLE_MONITOR_DAILY = "VEHICLE_MONITOR_DAILY", "车辆动态监控日报"

    class Status(models.TextChoices):
        CREATED = "CREATED", "已创建"
        WAITING_PLATFORM = "WAITING_PLATFORM", "等待省平台"
        FETCHING = "FETCHING", "取数中"
        VALIDATING = "VALIDATING", "校验中"
        REVIEW_REQUIRED = "REVIEW_REQUIRED", "待审核"
        APPROVED = "APPROVED", "已审核"
        DATA_INCOMPLETE = "DATA_INCOMPLETE", "数据不完整"
        REJECTED = "REJECTED", "已驳回"
        FAILED = "FAILED", "失败"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    report_type = models.CharField(max_length=40, choices=ReportType.choices, db_index=True)
    period_start = models.DateField()
    period_end = models.DateField()
    target_date = models.DateField(null=True, blank=True)
    template_version = models.CharField(max_length=80)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.CREATED, db_index=True)
    query_spec = EncryptedJSONField(default=dict)
    required_source_types = models.JSONField(default=list)
    validation_summary = EncryptedJSONField(default=dict)
    failure_code = models.CharField(max_length=80, blank=True, default="")
    failure_reason = models.CharField(max_length=1000, blank=True, default="")
    critical_issue_count = models.PositiveIntegerField(default=0)
    data_cutoff_at = models.DateTimeField()
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="requested_report_tasks")
    claimed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="claimed_report_tasks")
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="reviewed_report_tasks")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_note = models.CharField(max_length=1000, blank=True, default="")
    platform_account_ref = models.CharField(max_length=120, blank=True, default="")
    device_id = models.CharField(max_length=120, blank=True, default="")
    lease_token_hash = models.CharField(max_length=64, blank=True, default="")
    lease_expires_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        db_table = "assistant_report_tasks"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["status", "-created_at"], name="report_task_status_time_idx")]


class ReportSourceBatch(TimeStampedModel):
    class Status(models.TextChoices):
        PENDING = "PENDING", "等待取数"
        FETCHING = "FETCHING", "取数中"
        COMPLETE = "COMPLETE", "已完成"
        INVALID = "INVALID", "不完整"

    task = models.ForeignKey(ReportTask, on_delete=models.CASCADE, related_name="source_batches")
    source_type = models.CharField(max_length=50, db_index=True)
    contract_version = models.CharField(max_length=80)
    query_hash = models.CharField(max_length=64)
    field_signature = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True)
    total_pages = models.PositiveIntegerField(default=0)
    total_rows = models.PositiveIntegerField(default=0)
    received_pages = models.PositiveIntegerField(default=0)
    received_rows = models.PositiveIntegerField(default=0)
    valid_rows = models.PositiveIntegerField(default=0)
    duplicate_rows = models.PositiveIntegerField(default=0)
    anomaly_rows = models.PositiveIntegerField(default=0)
    filters_summary = models.JSONField(default=dict)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "assistant_report_source_batches"
        constraints = [models.UniqueConstraint(fields=["task", "source_type"], name="unique_task_report_source")]
        indexes = [models.Index(fields=["task", "status"], name="report_batch_task_status_idx")]


class ReportSourcePage(TimeStampedModel):
    task = models.ForeignKey(ReportTask, on_delete=models.CASCADE, related_name="source_pages")
    batch = models.ForeignKey(ReportSourceBatch, on_delete=models.CASCADE, related_name="pages")
    source_type = models.CharField(max_length=50)
    page_number = models.PositiveIntegerField()
    query_hash = models.CharField(max_length=64)
    field_signature = models.CharField(max_length=64)
    row_count = models.PositiveIntegerField()
    page_hash = models.CharField(max_length=64)
    rows = EncryptedJSONField(default=list)

    class Meta:
        db_table = "assistant_report_source_pages"
        constraints = [
            models.UniqueConstraint(fields=["task", "source_type", "page_number", "query_hash"], name="unique_report_source_page"),
        ]
        indexes = [models.Index(fields=["batch", "page_number"], name="report_page_batch_number_idx")]


class ReportSnapshot(TimeStampedModel):
    class PeriodType(models.TextChoices):
        DAILY = "DAILY", "日报"
        WEEKLY = "WEEKLY", "周报"
        MONTHLY = "MONTHLY", "月报"

    class ReviewStatus(models.TextChoices):
        PENDING = "PENDING", "待审核"
        APPROVED = "APPROVED", "已审核"
        REJECTED = "REJECTED", "已驳回"

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "草稿"
        PUBLISHED = "PUBLISHED", "已发布"
        RETIRED = "RETIRED", "已退役"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    task = models.ForeignKey(ReportTask, null=True, blank=True, on_delete=models.PROTECT, related_name="snapshots")
    report_type = models.CharField(max_length=40, default="LEGACY_OPERATIONAL", db_index=True)
    template_version = models.CharField(max_length=80, default="LEGACY_V1")
    review_status = models.CharField(max_length=20, choices=ReviewStatus.choices, default=ReviewStatus.PENDING, db_index=True)
    enterprise = models.ForeignKey("governance.EnterpriseScope", on_delete=models.PROTECT, related_name="report_snapshots")
    period_type = models.CharField(max_length=10, choices=PeriodType.choices)
    period_start = models.DateField()
    period_end = models.DateField()
    version = models.PositiveIntegerField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT, db_index=True)
    metrics = models.JSONField(default=dict)
    parameters = models.JSONField(default=dict)
    data_cutoff_at = models.DateTimeField()
    generated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="generated_reports")
    published_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="published_reports")
    published_at = models.DateTimeField(null=True, blank=True)
    correction_reason = models.CharField(max_length=1000, blank=True, default="")

    class Meta:
        db_table = "assistant_report_snapshots"
        ordering = ["-period_start", "-version"]
        constraints = [
            models.UniqueConstraint(fields=["enterprise", "report_type", "period_type", "period_start", "version"], name="unique_report_snapshot_version_v2"),
            models.UniqueConstraint(fields=["enterprise", "report_type", "period_type", "period_start"], condition=Q(status="PUBLISHED"), name="unique_published_report_period_v2"),
        ]
        indexes = [models.Index(fields=["enterprise", "report_type", "-period_start"], name="report_scope_type_period_idx")]


class VehicleMonitorDailyRow(TimeStampedModel):
    class RowKind(models.TextChoices):
        FORMAL = "FORMAL", "正式日报"
        FILTERED = "FILTERED", "过滤清单"
        ANOMALY = "ANOMALY", "异常清单"

    task = models.ForeignKey(ReportTask, on_delete=models.CASCADE, related_name="vehicle_daily_rows")
    snapshot = models.ForeignKey(ReportSnapshot, null=True, blank=True, on_delete=models.CASCADE, related_name="vehicle_daily_rows")
    enterprise = models.ForeignKey("governance.EnterpriseScope", null=True, blank=True, on_delete=models.PROTECT, related_name="vehicle_daily_rows")
    row_number = models.PositiveIntegerField()
    vehicle_key_hash = models.CharField(max_length=64, db_index=True)
    row_kind = models.CharField(max_length=20, choices=RowKind.choices, db_index=True)
    online_status = models.CharField(max_length=40, blank=True, default="")
    trajectory_status = models.CharField(max_length=60, blank=True, default="")
    filter_reason = models.CharField(max_length=200, blank=True, default="")
    anomaly_reason = models.CharField(max_length=500, blank=True, default="")
    critical = models.BooleanField(default=False, db_index=True)
    data = EncryptedJSONField(default=dict)
    vehicle_batch = models.ForeignKey(ReportSourceBatch, null=True, blank=True, on_delete=models.PROTECT, related_name="vehicle_daily_base_rows")
    trajectory_batch = models.ForeignKey(ReportSourceBatch, null=True, blank=True, on_delete=models.PROTECT, related_name="vehicle_daily_trajectory_rows")

    class Meta:
        db_table = "assistant_vehicle_monitor_daily_rows"
        constraints = [models.UniqueConstraint(fields=["task", "row_number"], name="unique_task_vehicle_daily_row")]
        indexes = [models.Index(fields=["task", "row_kind", "enterprise"], name="vehicle_daily_task_kind_idx")]


class ExportJob(TimeStampedModel):
    class Format(models.TextChoices):
        XLSX = "XLSX", "Excel"
        PDF = "PDF", "PDF"
        ZIP = "ZIP", "批量压缩包"

    class Status(models.TextChoices):
        READY = "READY", "可下载"
        EXPIRED = "EXPIRED", "已过期"
        DELETED = "DELETED", "已删除"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    report_snapshot = models.ForeignKey(ReportSnapshot, null=True, blank=True, on_delete=models.PROTECT, related_name="export_jobs")
    report_task = models.ForeignKey(ReportTask, null=True, blank=True, on_delete=models.PROTECT, related_name="export_jobs")
    format = models.CharField(max_length=10, choices=Format.choices)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.READY, db_index=True)
    purpose = models.CharField(max_length=500)
    file_name = models.CharField(max_length=255)
    file_path = models.CharField(max_length=500)
    file_sha256 = models.CharField(max_length=64)
    file_size = models.PositiveBigIntegerField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="report_exports")
    expires_at = models.DateTimeField(db_index=True)
    download_count = models.PositiveIntegerField(default=0)
    last_downloaded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "assistant_export_jobs"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(Q(report_snapshot__isnull=False, report_task__isnull=True) | Q(report_snapshot__isnull=True, report_task__isnull=False)),
                name="export_exactly_one_report_target",
            ),
        ]
        indexes = [models.Index(fields=["created_by", "status", "-created_at"], name="export_user_status_idx")]
