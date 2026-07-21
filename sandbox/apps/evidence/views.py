import json
import logging
import uuid
from functools import wraps
from io import BytesIO

from django.http import FileResponse, JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_GET, require_http_methods

from apps.governance.models import EnterpriseScope
from apps.governance.services import active_roles, enterprise_scope_for_user, enterprise_scope_ids_for_user, permissions_for_roles

from . import services
from .models import EvidenceRequest

logger = logging.getLogger("assistant.evidence")


def payload(request):
    if not request.body: return {}
    if len(request.body) > 256 * 1024: raise services.EvidenceError("请求体超过256KB限制", "PAYLOAD_TOO_LARGE", 413)
    try: value = json.loads(request.body)
    except json.JSONDecodeError as exc: raise services.EvidenceError("请求体不是有效JSON", "INVALID_JSON", 400) from exc
    if not isinstance(value, dict): raise services.EvidenceError("请求体必须是JSON对象", "INVALID_JSON", 400)
    return value


def uuid_value(value, label):
    try: return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc: raise services.EvidenceError(f"{label}标识无效", "INVALID_IDENTIFIER", 400) from exc


def boolean_value(value, label):
    if not isinstance(value, bool):
        raise services.EvidenceError(f"{label}必须是布尔值", "INVALID_BOOLEAN", 422)
    return value


def evidence_for(value):
    request = EvidenceRequest.objects.select_related("enterprise", "requested_by__assistant_profile", "reviewed_by__assistant_profile").filter(public_id=uuid_value(value, "证据申请")).first()
    if not request: raise services.EvidenceError("证据申请不存在", "EVIDENCE_NOT_FOUND", 404)
    return request


def enterprise_for(actor, value):
    enterprise = EnterpriseScope.objects.filter(public_id=uuid_value(value, "企业"), is_active=True).first()
    if not enterprise: raise services.EvidenceError("企业不存在", "ENTERPRISE_NOT_FOUND", 404)
    services.require_scope(actor, enterprise)
    return enterprise


def api_view(handler):
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
        if not profile or not profile.is_active:
            return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号"}, status=401)
        try: return handler(request, *args, **kwargs)
        except services.EvidenceError as exc: return JsonResponse({"ok": False, "code": exc.code, "message": str(exc)}, status=exc.status, json_dumps_params={"ensure_ascii": False})
        except Exception:
            logger.exception("evidence_api_error", extra={"path": request.path})
            return JsonResponse({"ok": False, "code": "INTERNAL_ERROR", "message": "证据服务内部异常"}, status=500)
    return wrapped


def request_data(item):
    return {
        "evidenceRequestId": str(item.public_id), "enterpriseId": str(item.enterprise.public_id), "enterpriseName": item.enterprise.name,
        "purpose": item.purpose, "eventCount": len(item.event_ids), "requestedFields": item.requested_fields, "status": item.status,
        "requestedBy": item.requested_by.assistant_profile.display_name, "reviewedBy": item.reviewed_by.assistant_profile.display_name if item.reviewed_by else None,
        "reviewComment": item.review_comment, "fileName": item.file_name or None, "fileHash": item.file_sha256 or None,
        "encryptionAlgorithm": item.encryption_algorithm or None, "expiresAt": item.expires_at.isoformat() if item.expires_at else None,
        "downloadCount": item.download_count, "createdAt": item.created_at.isoformat(),
    }


@require_GET
def home(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active: return redirect("assistant-login")
    permissions = permissions_for_roles(active_roles(request.user))
    if not set(permissions).intersection({"evidence.request", "evidence.review", "evidence.download"}): return render(request, "governance/access_denied.html", status=403)
    items = EvidenceRequest.objects.filter(enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related("enterprise", "requested_by__assistant_profile", "reviewed_by__assistant_profile")[:100]
    return render(request, "evidence/home.html", {"profile": profile, "permissions": permissions, "enterprise_scopes": enterprise_scope_for_user(request.user), "items": items, "allowed_fields": sorted(services.ALLOWED_FIELDS)})


@require_GET
@api_view
def list_api(request):
    permissions = permissions_for_roles(active_roles(request.user))
    if not set(permissions).intersection({"evidence.request", "evidence.review", "evidence.download"}): raise services.EvidenceError("当前角色不能查看敏感证据申请", "PERMISSION_DENIED", 403)
    items = EvidenceRequest.objects.filter(enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related("enterprise", "requested_by__assistant_profile", "reviewed_by__assistant_profile")[:100]
    return JsonResponse({"ok": True, "data": [request_data(item) for item in items], "limit": 100}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def create_api(request):
    data = payload(request)
    item = services.create_request(actor=request.user, enterprise=enterprise_for(request.user, data.get("enterpriseId")), event_ids=data.get("eventIds"), purpose=data.get("purpose"), requested_fields=data.get("requestedFields"))
    return JsonResponse({"ok": True, "data": request_data(item)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def review_api(request, evidence_id):
    data = payload(request)
    item = services.review_request(actor=request.user, request=evidence_for(evidence_id), approved=boolean_value(data.get("approved"), "审批结果"), comment=data.get("comment"))
    return JsonResponse({"ok": True, "data": request_data(item)}, json_dumps_params={"ensure_ascii": False})


@require_GET
@api_view
def download_api(request, evidence_id):
    item, content = services.record_download(actor=request.user, request=evidence_for(evidence_id))
    response = FileResponse(BytesIO(content), content_type="application/octet-stream", as_attachment=True, filename=item.file_name)
    response["Cache-Control"] = "no-store"
    response["X-Content-SHA256"] = item.file_sha256
    response["X-Evidence-Encryption"] = item.encryption_algorithm
    return response


def page_action(request, operation, evidence_id=None):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active: return redirect("assistant-login")
    try:
        if operation == "create":
            services.create_request(
                actor=request.user, enterprise=enterprise_for(request.user, request.POST.get("enterprise_id")),
                event_ids=[line.strip() for line in request.POST.get("event_ids", "").splitlines() if line.strip()],
                purpose=request.POST.get("purpose"), requested_fields=request.POST.getlist("requested_fields"),
            )
        else:
            services.review_request(actor=request.user, request=evidence_for(evidence_id), approved=operation == "approve", comment=request.POST.get("comment"))
        return redirect("evidence-home")
    except services.EvidenceError as exc:
        return render(request, "rule_governance/error.html", {"error": str(exc), "code": exc.code, "permissions": permissions_for_roles(active_roles(request.user))}, status=exc.status)


@require_http_methods(["POST"])
def create_page(request): return page_action(request, "create")


@require_http_methods(["POST"])
def approve_page(request, evidence_id): return page_action(request, "approve", evidence_id)


@require_http_methods(["POST"])
def reject_page(request, evidence_id): return page_action(request, "reject", evidence_id)
