import json
import logging
import uuid
from functools import wraps
from io import BytesIO

from django.http import FileResponse, JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from apps.governance.action_tokens import verify_action_token
from apps.governance.models import EnterpriseScope
from apps.governance.services import GovernanceError, active_roles, enterprise_scope_for_user, enterprise_scope_ids_for_user, permissions_for_roles

from . import services
from .models import ActionLease, DutyNotification, ExportJob, ReportSnapshot, VoiceInteractionEvidence

logger = logging.getLogger("assistant.reporting")


def payload(request):
    if not request.body:
        return {}
    if len(request.body) > 2 * 1024 * 1024:
        raise services.ReportingError("请求体超过2MB限制", "PAYLOAD_TOO_LARGE", 413)
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
    job = ExportJob.objects.select_related("report_snapshot__enterprise", "created_by__assistant_profile").filter(public_id=uuid_value(value, "导出任务")).first()
    if not job: raise services.ReportingError("导出任务不存在", "EXPORT_NOT_FOUND", 404)
    return job


def enterprise_for(request, value):
    enterprise = EnterpriseScope.objects.filter(public_id=uuid_value(value, "企业"), is_active=True).first()
    if not enterprise: raise services.ReportingError("企业不存在", "ENTERPRISE_NOT_FOUND", 404)
    services.require_scope(request.user, enterprise)
    return enterprise


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
        "periodType": snapshot.period_type, "periodStart": snapshot.period_start.isoformat(), "periodEnd": snapshot.period_end.isoformat(),
        "version": snapshot.version, "status": snapshot.status, "metrics": snapshot.metrics, "parameters": snapshot.parameters,
        "dataCutoffAt": snapshot.data_cutoff_at.isoformat(), "correctionReason": snapshot.correction_reason,
        "generatedBy": snapshot.generated_by.assistant_profile.display_name, "publishedAt": snapshot.published_at.isoformat() if snapshot.published_at else None,
    }


def export_data(job):
    return {
        "exportId": str(job.public_id), "reportId": str(job.report_snapshot.public_id), "format": job.format, "status": job.status,
        "purpose": job.purpose, "fileName": job.file_name, "fileHash": job.file_sha256, "fileSize": job.file_size,
        "expiresAt": job.expires_at.isoformat(), "downloadCount": job.download_count,
    }


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


@require_GET
def home(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active: return redirect("assistant-login")
    permissions = permissions_for_roles(active_roles(request.user))
    if "report.view" not in permissions: return render(request, "governance/access_denied.html", status=403)
    snapshots = ReportSnapshot.objects.filter(enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related("enterprise", "generated_by__assistant_profile", "published_by__assistant_profile")[:100]
    exports = ExportJob.objects.filter(report_snapshot__enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related("report_snapshot__enterprise")[:50]
    return render(request, "reporting/home.html", {"profile": profile, "permissions": permissions, "enterprise_scopes": enterprise_scope_for_user(request.user), "snapshots": snapshots, "exports": exports})


@require_http_methods(["POST"])
@ingest_api_view
def event_upsert_api(request):
    data = payload(request)
    fact, created = services.upsert_alarm_fact(actor=request.user, event=data.get("event"), decision=data.get("decision"), action=data.get("action"), source=data.get("source"))
    return JsonResponse({"ok": True, "created": created, "data": {"eventId": fact.event_id, "updatedAt": fact.updated_at.isoformat()}}, status=201 if created else 200)


@require_http_methods(["POST"])
@ingest_api_view
def action_lease_acquire_api(request):
    data = payload(request)
    allowed = {"eventId", "deviceId", "actionType", "durationSeconds", "mode"}
    if set(data) - allowed:
        raise services.ReportingError("动作租约请求包含未允许字段", "INVALID_ACTION_LEASE", 422)
    fact = services.fact_for_event(actor=request.user, event_id=data.get("eventId"))
    lease = services.acquire_action_lease(
        actor=request.user,
        fact=fact,
        device_id=data.get("deviceId"),
        action_type=data.get("actionType"),
        duration_seconds=data.get("durationSeconds", 120),
        mode=data.get("mode", "LIVE"),
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
    content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" if job.format == "XLSX" else "application/pdf"
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
