import json
import logging
import uuid
from functools import wraps

from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_GET, require_http_methods
from django.views.decorators.csrf import csrf_exempt

from apps.governance.services import active_roles, enterprise_scope_ids_for_user, permissions_for_roles
from apps.governance.action_tokens import verify_action_token
from apps.governance.services import GovernanceError

from . import services
from .models import DisposalCase

logger = logging.getLogger("assistant.disposals")


def payload(request):
    if not request.body:
        return {}
    if len(request.body) > 512 * 1024:
        raise services.DisposalError("请求体超过512KB限制", "PAYLOAD_TOO_LARGE", 413)
    try:
        value = json.loads(request.body)
    except json.JSONDecodeError as exc:
        raise services.DisposalError("请求体不是有效JSON", "INVALID_JSON", 400) from exc
    if not isinstance(value, dict):
        raise services.DisposalError("请求体必须是JSON对象", "INVALID_JSON", 400)
    return value


def public_id(value):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise services.DisposalError("处置工单标识无效", "INVALID_IDENTIFIER", 400) from exc


def boolean_value(value, label):
    if not isinstance(value, bool):
        raise services.DisposalError(f"{label}必须是布尔值", "INVALID_BOOLEAN", 422)
    return value


def case_for(value):
    case = DisposalCase.objects.select_related(
        "enterprise", "assigned_to__assistant_profile", "completed_by__assistant_profile", "reviewed_by__assistant_profile"
    ).filter(public_id=public_id(value)).first()
    if not case:
        raise services.DisposalError("处置工单不存在", "DISPOSAL_CASE_NOT_FOUND", 404)
    return case


def api_view(handler):
    @csrf_exempt
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
        if not profile or not profile.is_active:
            return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号"}, status=401)
        try:
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                try:
                    verify_action_token(request)
                except GovernanceError as exc:
                    raise services.DisposalError(str(exc), exc.code, exc.status) from exc
            return handler(request, *args, **kwargs)
        except services.DisposalError as exc:
            return JsonResponse({"ok": False, "code": exc.code, "message": str(exc)}, status=exc.status, json_dumps_params={"ensure_ascii": False})
        except Exception:
            logger.exception("disposal_api_error", extra={"path": request.path, "request_id": getattr(request, "request_id", "")})
            return JsonResponse({"ok": False, "code": "INTERNAL_ERROR", "message": "处置服务内部异常"}, status=500)
    return wrapped


def case_data(case, include_snapshots=False):
    data = {
        "caseId": str(case.public_id),
        "eventId": case.event_id,
        "alarmId": case.alarm_id,
        "enterpriseId": str(case.enterprise.public_id),
        "enterpriseCode": case.enterprise.code,
        "enterpriseName": case.enterprise.name,
        "sourceKind": case.source_kind,
        "alarmName": case.alarm_name,
        "vehicleNo": case.vehicle_no,
        "status": case.status,
        "requiresReview": case.requires_review,
        "assignedTo": case.assigned_to.assistant_profile.display_name if case.assigned_to and hasattr(case.assigned_to, "assistant_profile") else None,
        "assignedToUserId": str(case.assigned_to_id) if case.assigned_to_id else None,
        "resolutionCode": case.resolution_code,
        "resolutionNote": case.resolution_note,
        "reviewedBy": case.reviewed_by.assistant_profile.display_name if case.reviewed_by and hasattr(case.reviewed_by, "assistant_profile") else None,
        "reviewComment": case.review_comment,
        "version": case.version,
        "updatedAt": case.updated_at.isoformat(),
    }
    if include_snapshots:
        data["event"] = case.latest_event_snapshot
        data["decision"] = case.decision_snapshot
    return data


@require_GET
def home(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    permissions = permissions_for_roles(active_roles(request.user))
    if not set(permissions).intersection({"alarm.view", "disposal.review"}):
        return render(request, "governance/access_denied.html", status=403)
    cases = DisposalCase.objects.filter(enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related(
        "enterprise", "assigned_to__assistant_profile", "completed_by__assistant_profile", "reviewed_by__assistant_profile"
    )[:100]
    return render(request, "disposals/home.html", {"profile": profile, "permissions": permissions, "cases": cases})


@require_GET
@api_view
def list_api(request):
    if not set(permissions_for_roles(active_roles(request.user))).intersection({"alarm.view", "disposal.review"}):
        raise services.DisposalError("当前角色不能查看处置工单", "PERMISSION_DENIED", 403)
    cases = DisposalCase.objects.filter(enterprise_id__in=enterprise_scope_ids_for_user(request.user)).select_related(
        "enterprise", "assigned_to__assistant_profile", "completed_by__assistant_profile", "reviewed_by__assistant_profile"
    )[:100]
    return JsonResponse({"ok": True, "data": [case_data(case) for case in cases], "limit": 100}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def upsert_api(request):
    data = payload(request)
    case, created = services.upsert_manual_case(actor=request.user, event=data.get("event"), decision=data.get("decision"))
    return JsonResponse({"ok": True, "created": created, "data": case_data(case)}, status=201 if created else 200, json_dumps_params={"ensure_ascii": False})


def mutate(request, case_id, operation):
    data = payload(request)
    case = case_for(case_id)
    if operation == "takeover":
        case = services.takeover_case(actor=request.user, case=case, expected_version=data.get("expectedVersion"))
    elif operation == "note":
        case = services.add_note(actor=request.user, case=case, comment=data.get("comment"), expected_version=data.get("expectedVersion"))
    elif operation == "complete":
        case = services.complete_case(actor=request.user, case=case, resolution_code=data.get("resolutionCode"), resolution_note=data.get("resolutionNote"), expected_version=data.get("expectedVersion"))
    elif operation == "review":
        case = services.review_case(actor=request.user, case=case, approved=boolean_value(data.get("approved"), "复核结果"), comment=data.get("comment"), expected_version=data.get("expectedVersion"))
    elif operation == "reopen":
        case = services.reopen_case(actor=request.user, case=case, comment=data.get("comment"), expected_version=data.get("expectedVersion"))
    return JsonResponse({"ok": True, "data": case_data(case)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def takeover_api(request, case_id):
    return mutate(request, case_id, "takeover")


@require_http_methods(["POST"])
@api_view
def note_api(request, case_id):
    return mutate(request, case_id, "note")


@require_http_methods(["POST"])
@api_view
def complete_api(request, case_id):
    return mutate(request, case_id, "complete")


@require_http_methods(["POST"])
@api_view
def review_api(request, case_id):
    return mutate(request, case_id, "review")


@require_http_methods(["POST"])
@api_view
def reopen_api(request, case_id):
    return mutate(request, case_id, "reopen")
