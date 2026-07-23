import json
import logging
import uuid
from functools import wraps
from io import BytesIO

from django.http import FileResponse, JsonResponse
from django.db.models import Q
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from apps.governance.action_tokens import verify_action_token
from apps.governance.models import EnterpriseScope
from apps.governance.services import GovernanceError, active_roles, enterprise_scope_for_user, enterprise_scope_ids_for_user, permissions_for_roles

from . import report_tasks, services
from .models import ActionLease, DutyNotification, ExportJob, ReportSnapshot, ReportTask, VoiceInteractionEvidence

logger = logging.getLogger("assistant.reporting")


def payload(request, max_bytes=2 * 1024 * 1024):
    if not request.body:
        return {}
    if len(request.body) > max_bytes:
        raise services.ReportingError("请求体超过允许大小", "PAYLOAD_TOO_LARGE", 413)
    try: value = json.loads(request.body)
    except json.JSONDecodeError as exc: raise services.ReportingError("请求体不是有效JSON", "INVALID_JSON", 400) from exc
    if not isinstance(value, dict): raise services.ReportingError("请求体必须是JSON对象", "INVALID_JSON", 400)
    return value


def uuid_value(value, label):
    try: return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc: raise services.ReportingError(f"{label}标识无效", "INVALID_IDENTIFIER", 400) from exc


def snapshot_for(value):
    snapshot = ReportSnapshot.objects.select_related("enterprise", "generated_by__assistant_profile", "published_by__assistant_profile").filter(public_id=uuid_value(value, "报表")).first()
    if not snapshot: raise services.ReportingError("报表不存在", "REPORT_NOT_FOUND", 404)
    return snapshot


def export_for(value):
    job = ExportJob.objects.select_related("report_snapshot__enterprise", "report_task", "created_by__assistant_profile").filter(public_id=uuid_value(value, "导出任务")).first()
    if not job: raise services.ReportingError("导出任务不存在", "EXPORT_NOT_FOUND", 404)
    return job


def enterprise_for(request, value):
    enterprise = EnterpriseScope.objects.filter(public_id=uuid_value(value, "企业"), is_active=True).first()
    if not enterprise: raise services.ReportingError("企业不存在", "ENTERPRISE_NOT_FOUND", 404)
    services.require_scope(request.user, enterprise)
    return enterprise


def task_for(value, actor=None):
    task = ReportTask.objects.select_related("requested_by__assistant_profile", "claimed_by__assistant_profile", "reviewed_by__assistant_profile").filter(public_id=uuid_value(value, "报表任务")).first()
    if not task:
        raise services.ReportingError("报表任务不存在", "REPORT_TASK_NOT_FOUND", 404)
    if actor and task.requested_by_id != actor.pk:
        permissions = permissions_for_roles(active_roles(actor))
        collector_access = "report.collect" in permissions and (task.claimed_by_id in {None, actor.pk})
        if "report.publish" not in permissions and not collector_access:
            raise services.ReportingError("无权访问该报表任务", "REPORT_TASK_SCOPE_DENIED", 403)
    return task


def api_view(handler):
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
        if not profile or not profile.is_active:
            return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号"}, status=401)
        try: return handler(request, *args, **kwargs)
        except services.ReportingError as exc: return JsonResponse({"ok": False, "code": exc.code, "message": str(exc)}, status=exc.status, json_dumps_params={"ensure_ascii": False})
        except Exception:
            logger.exception("reporting_api_error", extra={"path": request.path, "request_id": getattr(request, "request_id", "")})
            return JsonResponse({"ok": False, "code": "INTERNAL_ERROR", "message": "报表服务内部异常"}, status=500)
    return wrapped


def ingest_api_view(handler):
    @csrf_exempt
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
        if not profile or not profile.is_active:
            return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号"}, status=401)
        try:
            try: verify_action_token(request)
            except GovernanceError as exc: raise services.ReportingError(str(exc), exc.code, exc.status) from exc
            return handler(request, *args, **kwargs)
        except services.ReportingError as exc:
            return JsonResponse({"ok": False, "code": exc.code, "message": str(exc)}, status=exc.status, json_dumps_params={"ensure_ascii": False})
        except Exception:
            logger.exception("report_ingest_error", extra={"path": request.path})
            return JsonResponse({"ok": False, "code": "INTERNAL_ERROR", "message": "事件入库服务内部异常"}, status=500)
    return wrapped


def snapshot_data(snapshot):
    return {
        "reportId": str(snapshot.public_id), "enterpriseId": str(snapshot.enterprise.public_id), "enterpriseName": snapshot.enterprise.name,
        "taskId": str(snapshot.task.public_id) if snapshot.task_id else None, "reportType": snapshot.report_type,
        "templateVersion": snapshot.template_version, "reviewStatus": snapshot.review_status,
        "periodType": snapshot.period_type, "periodStart": snapshot.period_start.isoformat(), "periodEnd": snapshot.period_end.isoformat(),
        "version": snapshot.version, "status": snapshot.status, "metrics": snapshot.metrics, "parameters": snapshot.parameters,
        "dataCutoffAt": snapshot.data_cutoff_at.isoformat(), "correctionReason": snapshot.correction_reason,
        "generatedBy": snapshot.generated_by.assistant_profile.display_name, "publishedAt": snapshot.published_at.isoformat() if snapshot.published_at else None,
    }


def export_data(job):
    return {
        "exportId": str(job.public_id), "reportId": str(job.report_snapshot.public_id) if job.report_snapshot_id else None,
        "taskId": str(job.report_task.public_id) if job.report_task_id else None, "format": job.format, "status": job.status,
        "purpose": job.purpose, "fileName": job.file_name, "fileHash": job.file_sha256, "fileSize": job.file_size,
        "expiresAt": job.expires_at.isoformat(), "downloadCount": job.download_count,
    }


def task_data(task, *, detail=False, include_lease=False):
    data = {
        "taskId": str(task.public_id), "reportType": task.report_type,
        "periodStart": task.period_start.isoformat(), "periodEnd": task.period_end.isoformat(),
        "targetDate": task.target_date.isoformat() if task.target_date else None,
        "templateVersion": task.template_version, "status": task.status,
        "requiredSourceTypes": task.required_source_types,
        "criticalIssueCount": task.critical_issue_count, "failureCode": task.failure_code or None,
        "failureReason": task.failure_reason or None, "dataCutoffAt": task.data_cutoff_at.isoformat(),
        "reviewedAt": task.reviewed_at.isoformat() if task.reviewed_at else None, "reviewNote": task.review_note or None,
        "claimedBy": task.claimed_by.assistant_profile.display_name if task.claimed_by_id else None,
    }
    if detail:
        data["querySpec"] = task.query_spec
        data["validationSummary"] = task.validation_summary
        data["sources"] = [{
            "sourceType": batch.source_type, "contractVersion": batch.contract_version,
            "queryHash": batch.query_hash, "fieldSignature": batch.field_signature or None,
            "rawFieldSignature": batch.raw_field_signature or None,
            "status": batch.status, "totalPages": batch.total_pages, "totalRows": batch.total_rows,
            "receivedPages": batch.received_pages, "receivedRows": batch.received_rows,
        } for batch in task.source_batches.order_by("source_type")]
        data["snapshots"] = [snapshot_data(item) for item in task.snapshots.select_related("enterprise", "generated_by__assistant_profile")]
    if include_lease:
        data["leaseToken"] = getattr(task, "_plain_lease_token", None)
        data["leaseExpiresAt"] = task.lease_expires_at.isoformat() if task.lease_expires_at else None
    return data


def action_lease_data(lease, *, include_token=False):
    data = {
        "leaseId": str(lease.public_id),
        "actionType": lease.action_type,
        "status": lease.status,
        "expiresAt": lease.expires_at.isoformat(),
        "resultCode": lease.result_code or None,
    }
    if include_token:
        data["leaseToken"] = getattr(lease, "_plain_token", None)
    return data


def notification_data(notification):
    return {
        "notificationId": str(notification.public_id),
        "eventId": notification.event_id,
        "enterpriseId": str(notification.enterprise.public_id),
        "kind": notification.kind,
        "resultCode": notification.result_code,
        "title": notification.title,
        "message": notification.message,
        "status": notification.status,
        "createdAt": notification.created_at.isoformat(),
        "acknowledgedAt": notification.acknowledged_at.isoformat() if notification.acknowledged_at else None,
    }


def voice_evidence_data(record, *, include_transcript=False):
    return services.voice_evidence_data(record, include_transcript=include_transcript)


@require_http_methods(["GET", "POST"])
@api_view
def report_tasks_api(request):
    if request.method == "GET":
        services.require_reporting_permission(request.user, "report.view")
        permissions = permissions_for_roles(active_roles(request.user))
        tasks = ReportTask.objects.all()
        if "report.publish" not in permissions:
            scope = Q(requested_by=request.user)
            if "report.collect" in permissions:
                scope |= Q(claimed_by=request.user) | Q(claimed_by__isnull=True, status=ReportTask.Status.WAITING_PLATFORM)
            tasks = tasks.filter(scope)
        tasks = tasks.select_related("requested_by__assistant_profile", "claimed_by__assistant_profile", "reviewed_by__assistant_profile").order_by("-created_at")[:100]
        return JsonResponse({"ok": True, "data": [task_data(item) for item in tasks], "limit": 100}, json_dumps_params={"ensure_ascii": False})
    data = payload(request)
    task = report_tasks.create_report_task(
        actor=request.user, report_type=data.get("reportType"), period_start=data.get("periodStart"),
        period_end=data.get("periodEnd"), data_cutoff_at=data.get("dataCutoffAt"),
    )
    return JsonResponse({"ok": True, "data": task_data(task, detail=True)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_GET
@api_view
def report_task_detail_api(request, task_id):
    services.require_reporting_permission(request.user, "report.view")
    return JsonResponse({"ok": True, "data": task_data(task_for(task_id, request.user), detail=True)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@ingest_api_view
def report_task_claim_api(request, task_id):
    data = payload(request)
    task = report_tasks.claim_report_task(
        actor=request.user, task=task_for(task_id, request.user), device_id=data.get("deviceId"), duration_seconds=data.get("durationSeconds", 600),
    )
    return JsonResponse({"ok": True, "data": task_data(task, detail=True, include_lease=True)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@ingest_api_view
def report_source_page_api(request, task_id, source_type):
    data = payload(request, max_bytes=10 * 1024 * 1024)
    page, created = report_tasks.upload_source_page(
        actor=request.user, task=task_for(task_id, request.user), source_type=source_type,
        page_number=data.get("pageNumber"), query_hash=data.get("queryHash"), field_signature=data.get("fieldSignature"),
        raw_field_signature=data.get("rawFieldSignature"),
        rows=data.get("rows"), device_id=data.get("deviceId"), lease_token=data.get("leaseToken"),
    )
    return JsonResponse({"ok": True, "data": {"pageId": page.pk, "pageNumber": page.page_number, "rowCount": page.row_count, "created": created}}, status=201 if created else 200)


@require_http_methods(["POST"])
@ingest_api_view
def report_source_complete_api(request, task_id, source_type):
    data = payload(request)
    batch, problems = report_tasks.complete_source_batch(
        actor=request.user, task=task_for(task_id, request.user), source_type=source_type,
        total_pages=data.get("totalPages"), total_rows=data.get("totalRows"), field_signature=data.get("fieldSignature"),
        raw_field_signature=data.get("rawFieldSignature"),
        device_id=data.get("deviceId"), lease_token=data.get("leaseToken"),
    )
    return JsonResponse({"ok": not problems, "code": "REPORT_SOURCE_INCOMPLETE" if problems else None, "message": "来源完整性校验失败" if problems else None, "data": {"sourceType": batch.source_type, "status": batch.status, "problems": problems}}, status=409 if problems else 200, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@ingest_api_view
def report_task_finalize_api(request, task_id):
    data = payload(request)
    task = task_for(task_id, request.user)
    report_tasks.verify_task_lease(task, request.user, data.get("deviceId"), data.get("leaseToken"))
    task = report_tasks.finalize_report_task(actor=request.user, task=task)
    if task.status == ReportTask.Status.DATA_INCOMPLETE:
        return JsonResponse({"ok": False, "code": task.failure_code, "message": task.failure_reason, "data": task_data(task, detail=True)}, status=409, json_dumps_params={"ensure_ascii": False})
    return JsonResponse({"ok": True, "data": task_data(task, detail=True)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@ingest_api_view
def report_task_incomplete_api(request, task_id):
    data = payload(request)
    task = report_tasks.mark_report_task_incomplete(
        actor=request.user, task=task_for(task_id, request.user), device_id=data.get("deviceId"),
        lease_token=data.get("leaseToken"), failure_code=data.get("failureCode"),
    )
    return JsonResponse({"ok": True, "data": task_data(task, detail=True)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def report_task_review_api(request, task_id):
    data = payload(request)
    task = report_tasks.review_report_task(
        actor=request.user, task=task_for(task_id, request.user), approve=data.get("decision") == "APPROVE", note=data.get("note"),
    )
    return JsonResponse({"ok": True, "data": task_data(task, detail=True)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def report_task_bundle_api(request, task_id):
    data = payload(request)
    job = report_tasks.create_task_bundle_export(actor=request.user, task=task_for(task_id, request.user), purpose=data.get("purpose"))
    return JsonResponse({"ok": True, "data": export_data(job)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def report_snapshot_task_export_api(request, report_id):
    data = payload(request)
    job = report_tasks.create_snapshot_export(actor=request.user, snapshot=snapshot_for(report_id), purpose=data.get("purpose"))
    return JsonResponse({"ok": True, "data": export_data(job)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_GET
def home(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active: return redirect("assistant-login")
    permissions = permissions_for_roles(active_roles(request.user))
    if "report.view" not in permissions: return render(request, "governance/access_denied.html", status=403)
    task_scope = Q(requested_by=request.user)
    if "report.collect" in permissions:
        task_scope |= Q(claimed_by=request.user) | Q(claimed_by__isnull=True, status=ReportTask.Status.WAITING_PLATFORM)
    if "report.publish" in permissions:
        task_scope = Q()
    tasks = ReportTask.objects.filter(task_scope).select_related("requested_by__assistant_profile", "claimed_by__assistant_profile", "reviewed_by__assistant_profile")[:100]
    snapshots = ReportSnapshot.objects.filter(enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related("enterprise", "generated_by__assistant_profile", "published_by__assistant_profile")[:100]
    exports = ExportJob.objects.filter(created_by=request.user).select_related("report_snapshot__enterprise", "report_task")[:50]
    return render(request, "reporting/home.html", {"profile": profile, "permissions": permissions, "enterprise_scopes": enterprise_scope_for_user(request.user), "tasks": tasks, "snapshots": snapshots, "exports": exports})


@require_http_methods(["POST"])
@ingest_api_view
def event_upsert_api(request):
    data = payload(request)
    fact, created = services.upsert_alarm_fact(actor=request.user, event=data.get("event"), decision=data.get("decision"), action=data.get("action"), source=data.get("source"))
    return JsonResponse({"ok": True, "created": created, "data": {
        "eventId": fact.event_id, "processingStatus": fact.processing_status,
        "processingSource": fact.processing_source or None,
        "processingMarkedAt": fact.processing_marked_at.isoformat() if fact.processing_marked_at else None,
        "updatedAt": fact.updated_at.isoformat(),
    }}, status=201 if created else 200)


@require_http_methods(["POST"])
@ingest_api_view
def action_lease_acquire_api(request):
    data = payload(request)
    allowed = {"eventId", "deviceId", "actionType", "durationSeconds"}
    if set(data) - allowed:
        raise services.ReportingError("动作租约请求包含未允许字段", "INVALID_ACTION_LEASE", 422)
    fact = services.fact_for_event(actor=request.user, event_id=data.get("eventId"))
    lease = services.acquire_action_lease(
        actor=request.user,
        fact=fact,
        device_id=data.get("deviceId"),
        action_type=data.get("actionType"),
        duration_seconds=data.get("durationSeconds", 120),
        require_registered_device=True,
    )
    return JsonResponse({"ok": True, "data": action_lease_data(lease, include_token=True)}, status=201)


@require_http_methods(["POST"])
@ingest_api_view
def action_lease_result_api(request, lease_id):
    data = payload(request)
    data["leaseId"] = str(lease_id)
    lease, notified = services.record_action_result(actor=request.user, payload=data)
    return JsonResponse({"ok": True, "data": {**action_lease_data(lease), "notificationCreated": notified}})


@require_GET
@api_view
def notifications_api(request):
    include_acknowledged = request.GET.get("includeAcknowledged") == "1"
    limit = request.GET.get("limit", 100)
    notifications = services.list_notifications(actor=request.user, include_acknowledged=include_acknowledged, limit=limit)
    return JsonResponse({"ok": True, "data": [notification_data(item) for item in notifications]}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@ingest_api_view
def notification_ack_api(request, notification_id):
    notification = DutyNotification.objects.select_related("enterprise").filter(public_id=uuid_value(notification_id, "通知")).first()
    if not notification:
        raise services.ReportingError("通知不存在", "NOTIFICATION_NOT_FOUND", 404)
    notification = services.acknowledge_notification(actor=request.user, notification=notification)
    return JsonResponse({"ok": True, "data": notification_data(notification)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@ingest_api_view
def voice_evidence_api(request, lease_id):
    data = payload(request)
    record, created = services.register_voice_evidence(actor=request.user, lease_id=lease_id, payload=data)
    return JsonResponse({"ok": True, "created": created, "data": voice_evidence_data(record)}, status=201 if created else 200)


@require_http_methods(["POST"])
@ingest_api_view
def voice_transcript_api(request, evidence_id):
    data = payload(request)
    record = VoiceInteractionEvidence.objects.filter(public_id=uuid_value(evidence_id, "语音证据")).first()
    if not record:
        raise services.ReportingError("语音证据不存在", "VOICE_EVIDENCE_NOT_FOUND", 404)
    record = services.submit_voice_transcript(actor=request.user, record=record, payload=data)
    # The submitting duty user receives status only; transcript review is a
    # separate permission held by evidence reviewers/system administrators.
    return JsonResponse({"ok": True, "data": voice_evidence_data(record)})


@require_GET
@api_view
def voice_evidence_detail_api(request, evidence_id):
    record, data = services.get_voice_evidence(
        actor=request.user, evidence_id=evidence_id, include_transcript=request.GET.get("includeTranscript") == "1",
    )
    return JsonResponse({"ok": True, "data": data}, json_dumps_params={"ensure_ascii": False})


@require_GET
@api_view
def list_api(request):
    if "report.view" not in permissions_for_roles(active_roles(request.user)): raise services.ReportingError("当前角色不能查看报表", "PERMISSION_DENIED", 403)
    snapshots = ReportSnapshot.objects.filter(enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related("enterprise", "generated_by__assistant_profile")[:100]
    return JsonResponse({"ok": True, "data": [snapshot_data(item) for item in snapshots], "limit": 100}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def generate_api(request):
    data = payload(request)
    snapshot = services.generate_report(
        actor=request.user, enterprise=enterprise_for(request, data.get("enterpriseId")),
        period_type=data.get("periodType"), period_value=data.get("periodValue"),
        correction_reason=data.get("correctionReason"), same_type_window_minutes=data.get("sameTypeWindowMinutes"),
    )
    return JsonResponse({"ok": True, "data": snapshot_data(snapshot)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def publish_api(request, report_id):
    snapshot = services.publish_report(actor=request.user, snapshot=snapshot_for(report_id))
    return JsonResponse({"ok": True, "data": snapshot_data(snapshot)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def export_api(request, report_id):
    data = payload(request)
    job = services.create_export(actor=request.user, snapshot=snapshot_for(report_id), format_name=data.get("format"), purpose=data.get("purpose"))
    return JsonResponse({"ok": True, "data": export_data(job)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_GET
@api_view
def download_api(request, export_id):
    job, content = services.record_download(actor=request.user, job=export_for(export_id))
    content_type = {
        "XLSX": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ZIP": "application/zip",
    }.get(job.format, "application/pdf")
    response = FileResponse(BytesIO(content), content_type=content_type, as_attachment=True, filename=job.file_name)
    response["Cache-Control"] = "no-store"
    response["X-Content-SHA256"] = job.file_sha256
    return response


def page_action(request, operation, report_id=None):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active: return redirect("assistant-login")
    try:
        if operation == "generate":
            services.generate_report(
                actor=request.user, enterprise=enterprise_for(request, request.POST.get("enterprise_id")),
                period_type=request.POST.get("period_type"), period_value=request.POST.get("period_value"),
                correction_reason=request.POST.get("correction_reason"), same_type_window_minutes=request.POST.get("same_type_window_minutes"),
            )
        elif operation == "publish": services.publish_report(actor=request.user, snapshot=snapshot_for(report_id))
        elif operation == "export": services.create_export(actor=request.user, snapshot=snapshot_for(report_id), format_name=request.POST.get("format"), purpose=request.POST.get("purpose"))
        return redirect("reporting-home")
    except services.ReportingError as exc:
        return render(request, "rule_governance/error.html", {"error": str(exc), "code": exc.code, "permissions": permissions_for_roles(active_roles(request.user))}, status=exc.status)


@require_http_methods(["POST"])
def generate_page(request): return page_action(request, "generate")


@require_http_methods(["POST"])
def publish_page(request, report_id): return page_action(request, "publish", report_id)


@require_http_methods(["POST"])
def export_page(request, report_id): return page_action(request, "export", report_id)


def task_page_action(request, operation, task_id=None):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    try:
        if operation == "create":
            report_tasks.create_report_task(
                actor=request.user, report_type=request.POST.get("report_type"),
                period_start=request.POST.get("period_start"), period_end=request.POST.get("period_end"),
            )
        elif operation == "approve":
            report_tasks.review_report_task(actor=request.user, task=task_for(task_id, request.user), approve=True, note=request.POST.get("note"))
        elif operation == "reject":
            report_tasks.review_report_task(actor=request.user, task=task_for(task_id, request.user), approve=False, note=request.POST.get("note"))
        elif operation == "bundle":
            report_tasks.create_task_bundle_export(actor=request.user, task=task_for(task_id, request.user), purpose=request.POST.get("purpose"))
        return redirect("reporting-home")
    except services.ReportingError as exc:
        return render(request, "rule_governance/error.html", {"error": str(exc), "code": exc.code, "permissions": permissions_for_roles(active_roles(request.user))}, status=exc.status)


@require_http_methods(["POST"])
def task_create_page(request): return task_page_action(request, "create")


@require_http_methods(["POST"])
def task_approve_page(request, task_id): return task_page_action(request, "approve", task_id)


@require_http_methods(["POST"])
def task_reject_page(request, task_id): return task_page_action(request, "reject", task_id)


@require_http_methods(["POST"])
def task_bundle_page(request, task_id): return task_page_action(request, "bundle", task_id)
