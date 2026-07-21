from functools import wraps
import json
import logging
import uuid

from django.contrib.auth import authenticate, login, logout
from django.contrib.auth import get_user_model
from django.db.models import Prefetch
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.middleware.csrf import get_token
from django.views.decorators.http import require_GET
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt

from . import services
from .action_tokens import TOKEN_MAX_AGE_SECONDS, issue_action_token, verify_action_token
from .models import AssistantProfile, DutyShift, EnterpriseGrant, EnterpriseScope, RoleAssignment

logger = logging.getLogger("assistant.governance")


@require_GET
def csrf_token_api(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号"}, status=401)
    return JsonResponse({"ok": True, "data": {"csrfToken": get_token(request)}})


@require_GET
def action_token_api(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号"}, status=401)
    token = issue_action_token(request)
    response = JsonResponse({"ok": True, "data": {"actionToken": token, "expiresInSeconds": TOKEN_MAX_AGE_SECONDS}})
    response["Cache-Control"] = "no-store"
    return response


def home_context(user, error=None):
    roles = services.active_roles(user)
    return {
        "profile": user.assistant_profile,
        "roles": roles,
        "permissions": services.permissions_for_roles(roles),
        "enterprise_scopes": services.enterprise_scope_for_user(user),
        "active_shift": services.active_shift_for_user(user),
        "error": error,
    }


def admin_context(user, error=None):
    users = get_user_model().objects.filter(assistant_profile__isnull=False).select_related("assistant_profile").prefetch_related("assistant_roles", "assistant_enterprise_grants__enterprise").order_by("assistant_profile__display_name")[:200]
    return {
        "profile": user.assistant_profile,
        "users": users,
        "enterprise_scopes": EnterpriseScope.objects.filter(is_active=True).select_related("parent").order_by("code")[:500],
        "role_choices": RoleAssignment.Role.choices,
        "scope_type_choices": EnterpriseScope.ScopeType.choices,
        "keepalive_policy": services.keepalive_policy(),
        "error": error,
    }


def json_payload(request):
    if not request.body:
        return {}
    if len(request.body) > 64 * 1024:
        raise services.GovernanceError("请求体超过64KB限制", "PAYLOAD_TOO_LARGE", 413)
    try:
        value = json.loads(request.body)
    except json.JSONDecodeError as exc:
        raise services.GovernanceError("请求体不是有效JSON", "INVALID_JSON") from exc
    if not isinstance(value, dict):
        raise services.GovernanceError("请求体必须是JSON对象", "INVALID_JSON")
    return value


def uuid_value(value, field_name):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise services.GovernanceError(f"{field_name}不是有效标识", "INVALID_IDENTIFIER") from exc


@require_http_methods(["GET"])
def home(request):
    if not request.user.is_authenticated:
        return redirect("assistant-login")
    profile = getattr(request.user, "assistant_profile", None)
    if not profile or not profile.is_active:
        return render(request, "governance/access_denied.html", status=403)
    return render(request, "governance/home.html", home_context(request.user))


@require_http_methods(["GET", "POST"])
def login_page(request):
    if not AssistantProfile.objects.exists():
        return redirect("assistant-setup")
    if request.user.is_authenticated:
        return redirect("assistant-home")
    error = None
    if request.method == "POST":
        username = request.POST.get("username", "").strip()
        password = request.POST.get("password", "")
        user = authenticate(request, username=username, password=password)
        profile = getattr(user, "assistant_profile", None) if user else None
        if user and profile and profile.is_active:
            login(request, user)
            return redirect("assistant-home")
        error = "账号、密码错误，或该账号没有有效的实名助手档案"
    return render(request, "governance/login.html", {"error": error})


@require_http_methods(["GET", "POST"])
def setup_page(request):
    if AssistantProfile.objects.exists():
        return redirect("assistant-login")
    if request.META.get("REMOTE_ADDR") not in {"127.0.0.1", "::1"}:
        return render(request, "governance/access_denied.html", status=403)
    error = None
    if request.method == "POST":
        try:
            user = services.bootstrap_first_admin(
                username=request.POST.get("username"), display_name=request.POST.get("display_name"),
                employee_code=request.POST.get("employee_code"), password=request.POST.get("password"),
            )
            login(request, user)
            return redirect("assistant-admin")
        except services.GovernanceError as exc:
            error = str(exc)
    return render(request, "governance/setup.html", {"error": error})


@require_http_methods(["GET"])
def admin_page(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    try:
        services.require_permission(request.user, "identity.manage")
        services.require_permission(request.user, "enterprise.manage")
    except services.GovernanceError:
        return render(request, "governance/access_denied.html", status=403)
    return render(request, "governance/admin.html", admin_context(request.user))


@require_http_methods(["POST"])
def admin_action_page(request, operation):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    try:
        if operation == "create-user":
            services.create_assistant_user(
                actor=request.user, username=request.POST.get("username"), display_name=request.POST.get("display_name"),
                employee_code=request.POST.get("employee_code"), password=request.POST.get("password"), role=request.POST.get("role"),
            )
        elif operation == "create-enterprise":
            parent_id = request.POST.get("parent_id")
            parent = EnterpriseScope.objects.filter(public_id=uuid_value(parent_id, "parent_id"), is_active=True).first() if parent_id else None
            services.create_enterprise_scope(
                actor=request.user, code=request.POST.get("code"), name=request.POST.get("name"),
                scope_type=request.POST.get("scope_type"), parent=parent,
            )
        elif operation == "assign-role":
            user = get_user_model().objects.filter(pk=request.POST.get("user_id"), assistant_profile__is_active=True).first()
            if not user: raise services.GovernanceError("实名用户不存在", "USER_NOT_FOUND", 404)
            services.require_permission(request.user, "identity.manage")
            services.assign_role(user=user, role=request.POST.get("role"), assigned_by=request.user)
        elif operation == "grant-enterprise":
            user = get_user_model().objects.filter(pk=request.POST.get("user_id"), assistant_profile__is_active=True).first()
            enterprise = EnterpriseScope.objects.filter(public_id=uuid_value(request.POST.get("enterprise_id"), "enterprise_id"), is_active=True).first()
            if not user or not enterprise: raise services.GovernanceError("用户或企业范围不存在", "GRANT_TARGET_NOT_FOUND", 404)
            services.grant_enterprise(user=user, enterprise=enterprise, actor=request.user, can_view_sensitive=request.POST.get("can_view_sensitive") == "on")
        elif operation == "session-keepalive-policy":
            services.update_keepalive_policy(
                actor=request.user, enabled=request.POST.get("enabled") == "on",
                interval_minutes=request.POST.get("interval_minutes"), request_id=getattr(request, "request_id", ""),
            )
        else:
            raise services.GovernanceError("无效管理操作", "INVALID_ADMIN_OPERATION", 400)
        return redirect("assistant-admin")
    except services.GovernanceError as exc:
        return render(request, "governance/admin.html", admin_context(request.user, str(exc)), status=exc.status)


@require_http_methods(["POST"])
def logout_page(request):
    logout(request)
    return redirect("assistant-login")


@require_http_methods(["POST"])
def claim_shift_page(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    try:
        services.claim_shift(
            user=request.user,
            platform_account_ref=request.POST.get("platform_account_ref"),
            workstation_id=request.POST.get("workstation_id"),
            request_id=getattr(request, "request_id", ""),
        )
        return redirect("assistant-home")
    except services.GovernanceError as exc:
        return render(request, "governance/home.html", home_context(request.user, str(exc)), status=exc.status)


@require_http_methods(["POST"])
def release_shift_page(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    try:
        services.release_shift(user=request.user, request_id=getattr(request, "request_id", ""))
        return redirect("assistant-home")
    except services.GovernanceError as exc:
        return render(request, "governance/home.html", home_context(request.user, str(exc)), status=exc.status)


def api_view(handler):
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录助手系统", "requestId": getattr(request, "request_id", None)}, status=401)
        profile = getattr(request.user, "assistant_profile", None)
        if not profile or not profile.is_active:
            return JsonResponse({"ok": False, "code": "ASSISTANT_PROFILE_REQUIRED", "message": "当前账号没有有效的实名助手档案", "requestId": getattr(request, "request_id", None)}, status=403)
        try:
            return handler(request, *args, **kwargs)
        except services.GovernanceError as exc:
            return JsonResponse({"ok": False, "code": exc.code, "message": str(exc), "requestId": getattr(request, "request_id", None)}, status=exc.status)
        except Exception:
            logger.exception("governance_api_error", extra={"request_id": getattr(request, "request_id", None), "path": request.path})
            return JsonResponse({"ok": False, "code": "INTERNAL_ERROR", "message": "助手权限服务内部异常", "requestId": getattr(request, "request_id", None)}, status=500)
    return wrapped


@require_GET
@api_view
def current_user(request):
    return JsonResponse({
        "ok": True,
        "data": services.identity_payload(request.user),
    }, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def claim_shift_api(request):
    data = json_payload(request)
    shift = services.claim_shift(
        user=request.user,
        platform_account_ref=data.get("platformAccountRef"),
        workstation_id=data.get("workstationId"),
        request_id=getattr(request, "request_id", ""),
    )
    return JsonResponse({"ok": True, "data": services.shift_payload(shift)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def release_shift_api(request):
    shift = services.release_shift(user=request.user, request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": services.shift_payload(shift)}, json_dumps_params={"ensure_ascii": False})


@require_GET
@api_view
def users_api(request):
    services.require_permission(request.user, "identity.manage")
    users = list(get_user_model().objects.filter(assistant_profile__isnull=False).select_related("assistant_profile").prefetch_related(
        Prefetch("assistant_roles", queryset=RoleAssignment.objects.filter(is_active=True), to_attr="prefetched_active_roles"),
        Prefetch("assistant_enterprise_grants", queryset=EnterpriseGrant.objects.filter(enterprise__is_active=True).select_related("enterprise"), to_attr="prefetched_enterprise_grants"),
        Prefetch("assistant_duty_shifts", queryset=DutyShift.objects.filter(ended_at__isnull=True), to_attr="prefetched_active_shifts"),
    ).order_by("pk")[:200])
    return JsonResponse({"ok": True, "data": [services.identity_payload(user) for user in users], "limit": 200}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def assign_role_api(request, user_id):
    services.require_permission(request.user, "identity.manage")
    data = json_payload(request)
    user = get_user_model().objects.filter(pk=user_id, assistant_profile__is_active=True).first()
    if not user:
        raise services.GovernanceError("实名助手用户不存在", "USER_NOT_FOUND", 404)
    assignment = services.assign_role(user=user, role=data.get("role"), assigned_by=request.user, request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": {"userId": str(user.pk), "role": assignment.role}}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def deactivate_role_api(request, user_id):
    data = json_payload(request)
    user = get_user_model().objects.filter(pk=user_id, assistant_profile__is_active=True).first()
    if not user:
        raise services.GovernanceError("实名助手用户不存在", "USER_NOT_FOUND", 404)
    assignment = services.deactivate_role(user=user, role=data.get("role"), actor=request.user, request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": {"userId": str(user.pk), "role": assignment.role, "active": False}}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def grant_enterprise_api(request, user_id):
    data = json_payload(request)
    user = get_user_model().objects.filter(pk=user_id, assistant_profile__is_active=True).first()
    if not user:
        raise services.GovernanceError("实名助手用户不存在", "USER_NOT_FOUND", 404)
    enterprise = EnterpriseScope.objects.filter(public_id=uuid_value(data.get("enterpriseId"), "enterpriseId"), is_active=True).first()
    if not enterprise:
        raise services.GovernanceError("企业范围不存在", "ENTERPRISE_NOT_FOUND", 404)
    grant = services.grant_enterprise(user=user, enterprise=enterprise, actor=request.user, can_view_sensitive=data.get("canViewSensitive", False), request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": {"userId": str(user.pk), "enterpriseId": str(grant.enterprise.public_id), "canViewSensitive": grant.can_view_sensitive}}, json_dumps_params={"ensure_ascii": False})


@csrf_exempt
@require_http_methods(["GET", "POST"])
@api_view
def session_keepalive_policy_api(request):
    if request.method == "GET":
        permissions = services.permissions_for_roles(services.active_roles(request.user))
        if not {"session.keepalive.execute", "system.configure"}.intersection(permissions):
            raise services.GovernanceError("当前角色不能读取会话保活策略", "PERMISSION_DENIED", 403)
        return JsonResponse({"ok": True, "code": "OK", "message": "策略读取成功", "data": services.keepalive_policy_payload(services.keepalive_policy())})
    verify_action_token(request)
    data = json_payload(request)
    if set(data) - {"enabled", "intervalMinutes"}:
        raise services.GovernanceError("策略只允许修改启用状态和间隔", "INVALID_KEEPALIVE_POLICY", 422)
    if not isinstance(data.get("enabled"), bool):
        raise services.GovernanceError("enabled必须是布尔值", "INVALID_KEEPALIVE_POLICY", 422)
    policy = services.update_keepalive_policy(
        actor=request.user, enabled=data["enabled"], interval_minutes=data.get("intervalMinutes"),
        request_id=getattr(request, "request_id", ""),
    )
    return JsonResponse({"ok": True, "code": "OK", "message": "策略已更新", "data": services.keepalive_policy_payload(policy)})


@csrf_exempt
@require_http_methods(["GET", "POST"])
@api_view
def voice_interaction_policy_api(request):
    if request.method == "GET":
        permissions = services.permissions_for_roles(services.active_roles(request.user))
        if not {"action.execute", "system.configure"}.intersection(permissions):
            raise services.GovernanceError("当前角色不能读取语音证据策略", "PERMISSION_DENIED", 403)
        return JsonResponse({"ok": True, "code": "OK", "message": "语音证据策略读取成功", "data": services.voice_interaction_policy_payload(services.voice_interaction_policy())})
    verify_action_token(request)
    data = json_payload(request)
    allowed = {"enabled", "recordDriverAudio", "transcribeDriverAudio", "retentionDays"}
    if set(data) - allowed:
        raise services.GovernanceError("语音证据策略包含未允许字段", "INVALID_VOICE_POLICY", 422)
    policy = services.update_voice_interaction_policy(
        actor=request.user, enabled=data.get("enabled"), record_driver_audio=data.get("recordDriverAudio"),
        transcribe_driver_audio=data.get("transcribeDriverAudio"), retention_days=data.get("retentionDays"),
        request_id=getattr(request, "request_id", ""),
    )
    return JsonResponse({"ok": True, "code": "OK", "message": "语音证据策略已更新", "data": services.voice_interaction_policy_payload(policy)})


@csrf_exempt
@require_http_methods(["POST"])
@api_view
def device_heartbeat_api(request):
    verify_action_token(request)
    data = json_payload(request)
    allowed = {"deviceId", "extensionVersion", "platformAccountRef", "sessionStatus", "route", "platformContext"}
    if set(data) - allowed:
        raise services.GovernanceError("设备心跳包含未允许字段", "INVALID_DEVICE_HEARTBEAT", 422)
    device = services.register_device_heartbeat(
        actor=request.user, device_id=data.get("deviceId"), extension_version=data.get("extensionVersion"),
        platform_account_ref=data.get("platformAccountRef"), session_status=data.get("sessionStatus"), route=data.get("route"),
        platform_context=data.get("platformContext"),
    )
    return JsonResponse({"ok": True, "code": "OK", "message": "设备心跳已记录", "data": {"deviceId": device.device_id, "lastSeenAt": device.last_seen_at.isoformat()}})


@csrf_exempt
@require_http_methods(["POST"])
@api_view
def session_keepalive_audit_api(request):
    verify_action_token(request)
    audit = services.record_keepalive_audit(actor=request.user, payload=json_payload(request))
    return JsonResponse({"ok": True, "code": "OK", "message": "保活审计已记录", "data": {"auditId": str(audit.public_id)}} , status=201)
