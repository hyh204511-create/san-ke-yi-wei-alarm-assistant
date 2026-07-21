import json
import logging
import uuid
from functools import wraps

from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_GET, require_http_methods

from apps.governance.services import GovernanceError, active_roles, enterprise_scope_for_user, permissions_for_roles, require_permission

from . import services
from .models import RulePackage

logger = logging.getLogger("assistant.rules")


def json_payload(request):
    if not request.body:
        return {}
    if len(request.body) > 2 * 1024 * 1024:
        raise services.RuleGovernanceError("请求体超过2MB限制", "PAYLOAD_TOO_LARGE", 413)
    try:
        value = json.loads(request.body)
    except json.JSONDecodeError as exc:
        raise services.RuleGovernanceError("请求体不是有效JSON", "INVALID_JSON") from exc
    if not isinstance(value, dict):
        raise services.RuleGovernanceError("请求体必须是JSON对象", "INVALID_JSON")
    return value


def parse_payload_text(value):
    try:
        payload = json.loads(value or "{}")
    except json.JSONDecodeError as exc:
        raise services.RuleGovernanceError("规则内容不是有效JSON", "INVALID_JSON") from exc
    if not isinstance(payload, dict):
        raise services.RuleGovernanceError("规则内容必须是JSON对象", "INVALID_JSON")
    return payload


def public_id(value):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise services.RuleGovernanceError("规则包标识无效", "INVALID_IDENTIFIER") from exc


def get_package(value):
    package = RulePackage.objects.filter(public_id=public_id(value)).select_related("created_by", "reviewed_by").first()
    if not package:
        raise services.RuleGovernanceError("规则包不存在", "RULE_PACKAGE_NOT_FOUND", 404)
    return package


def api_view(handler):
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
        if not profile or not profile.is_active:
            return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号", "requestId": getattr(request, "request_id", None)}, status=401)
        try:
            return handler(request, *args, **kwargs)
        except (services.RuleGovernanceError, GovernanceError) as exc:
            response = {"ok": False, "code": exc.code, "message": str(exc), "requestId": getattr(request, "request_id", None)}
            if getattr(exc, "errors", None):
                response["errors"] = exc.errors
            return JsonResponse(response, status=exc.status, json_dumps_params={"ensure_ascii": False})
        except Exception:
            logger.exception("rule_governance_api_error", extra={"request_id": getattr(request, "request_id", None), "path": request.path})
            return JsonResponse({"ok": False, "code": "INTERNAL_ERROR", "message": "规则治理服务内部异常", "requestId": getattr(request, "request_id", None)}, status=500)
    return wrapped


def package_data(package, include_payload=True):
    data = {
        "rulePackageId": str(package.public_id),
        "version": package.version,
        "status": package.status,
        "contentHash": package.content_hash,
        "changeNote": package.change_note,
        "createdBy": package.created_by.assistant_profile.display_name if hasattr(package.created_by, "assistant_profile") else package.created_by.get_username(),
        "reviewedBy": package.reviewed_by.assistant_profile.display_name if package.reviewed_by and hasattr(package.reviewed_by, "assistant_profile") else None,
        "reviewComment": package.review_comment,
        "submittedAt": package.submitted_at.isoformat() if package.submitted_at else None,
        "reviewedAt": package.reviewed_at.isoformat() if package.reviewed_at else None,
        "publishedAt": package.published_at.isoformat() if package.published_at else None,
        "createdAt": package.created_at.isoformat(),
        "enterpriseScopes": [{
            "enterpriseId": str(scope.public_id),
            "enterpriseCode": scope.code,
            "enterpriseName": scope.name,
            "scopeType": scope.scope_type,
        } for scope in package.enterprise_scopes.all()],
    }
    if include_payload:
        data["payload"] = package.payload
    return data


@require_GET
def home(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    roles = active_roles(request.user)
    permissions = permissions_for_roles(roles)
    if not set(permissions).intersection({"rule.draft", "rule.review", "rule.publish"}):
        return render(request, "governance/access_denied.html", status=403)
    packages = RulePackage.objects.select_related("created_by", "reviewed_by").prefetch_related("review_events", "enterprise_scopes").all()[:100]
    sample_payload = {
        "schemaVersion": 2,
        "version": "rules-v2.0.0",
        "rules": [{
            "id": "rule-example-text",
            "name": "示例文本优先规则",
            "enabled": True,
            "priority": 100,
            "match": {"alarmNames": ["待替换报警类型"], "sourceKinds": ["REALTIME"]},
            "handlingMode": "AUTO",
            "channels": [{"type": "TEXT", "order": 1, "templateId": "text-example-v1", "recipientType": "DRIVER_TERMINAL", "terminalTts": True}],
            "fallback": "MANUAL",
        }],
    }
    return render(request, "rule_governance/home.html", {
        "profile": profile,
        "permissions": permissions,
        "packages": packages,
        "enterprise_scopes": enterprise_scope_for_user(request.user),
        "sample_payload": json.dumps(sample_payload, ensure_ascii=False, indent=2),
    })


@require_GET
@api_view
def list_api(request):
    permissions = permissions_for_roles(active_roles(request.user))
    if not set(permissions).intersection({"rule.draft", "rule.review", "rule.publish"}):
        raise services.RuleGovernanceError("当前角色不能查看规则中心", "PERMISSION_DENIED", 403)
    packages = RulePackage.objects.select_related("created_by", "reviewed_by").prefetch_related("enterprise_scopes").all()[:100]
    return JsonResponse({"ok": True, "data": [package_data(package) for package in packages], "limit": 100}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def create_api(request):
    data = json_payload(request)
    package = services.create_draft(actor=request.user, version=data.get("version"), payload=data.get("payload"), change_note=data.get("changeNote"), enterprise_scope_ids=data.get("enterpriseScopeIds"), request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": package_data(package)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["PUT", "POST"])
@api_view
def update_api(request, package_id):
    data = json_payload(request)
    package = services.update_draft(actor=request.user, package=get_package(package_id), payload=data.get("payload"), change_note=data.get("changeNote"), enterprise_scope_ids=data.get("enterpriseScopeIds") if "enterpriseScopeIds" in data else None, request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": package_data(package)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def submit_api(request, package_id):
    package = services.submit_for_review(actor=request.user, package=get_package(package_id), request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": package_data(package)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def approve_api(request, package_id):
    data = json_payload(request)
    package = services.review_package(actor=request.user, package=get_package(package_id), approved=True, comment=data.get("comment"), request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": package_data(package)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def reject_api(request, package_id):
    data = json_payload(request)
    package = services.review_package(actor=request.user, package=get_package(package_id), approved=False, comment=data.get("comment"), request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": package_data(package)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def publish_api(request, package_id):
    package = services.publish_package(actor=request.user, package=get_package(package_id), request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": package_data(package)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def rollback_api(request, package_id):
    data = json_payload(request)
    package = services.rollback_to_package(actor=request.user, target=get_package(package_id), new_version=data.get("newVersion"), comment=data.get("comment"), request_id=getattr(request, "request_id", ""))
    return JsonResponse({"ok": True, "data": package_data(package)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_GET
@api_view
def runtime_api(request):
    require_permission(request.user, "rule.runtime")
    package = services.published_package(request.user)
    runtime = services.native_runtime_rule_set(package)
    referenced_asset_keys = set()
    for rule in runtime.get("rules", []):
        for channel in rule.get("channels") or []:
            key = channel.get("templateId") if channel.get("type") == "TEXT" else channel.get("assetId") if channel.get("type") == "VOICE" else None
            if key:
                referenced_asset_keys.add(key)
    from apps.response_governance.services import published_assets_for_actor, runtime_asset_payload
    response_assets = [runtime_asset_payload(asset) for asset in published_assets_for_actor(request.user, referenced_asset_keys)]
    return JsonResponse({
        "ok": True,
        "data": {
            "rulePackage": {
                "rulePackageId": str(package.public_id),
                "version": package.version,
                "status": package.status,
                "contentHash": package.content_hash,
                "publishedAt": package.published_at.isoformat() if package.published_at else None,
            },
            "runtimeRuleSet": runtime,
            "responseAssets": response_assets,
        },
    }, json_dumps_params={"ensure_ascii": False})


def page_action(request, action, package_id=None):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    try:
        if action == "create":
            services.create_draft(actor=request.user, version=request.POST.get("version"), payload=parse_payload_text(request.POST.get("payload")), change_note=request.POST.get("change_note"), enterprise_scope_ids=request.POST.getlist("enterprise_scope_ids"), request_id=getattr(request, "request_id", ""))
        else:
            package = get_package(package_id)
            if action == "submit":
                services.submit_for_review(actor=request.user, package=package, request_id=getattr(request, "request_id", ""))
            elif action == "approve":
                services.review_package(actor=request.user, package=package, approved=True, comment=request.POST.get("comment"), request_id=getattr(request, "request_id", ""))
            elif action == "reject":
                services.review_package(actor=request.user, package=package, approved=False, comment=request.POST.get("comment"), request_id=getattr(request, "request_id", ""))
            elif action == "publish":
                services.publish_package(actor=request.user, package=package, request_id=getattr(request, "request_id", ""))
            elif action == "rollback":
                services.rollback_to_package(actor=request.user, target=package, new_version=request.POST.get("new_version"), comment=request.POST.get("comment"), request_id=getattr(request, "request_id", ""))
        return redirect("rule-center-home")
    except (services.RuleGovernanceError, GovernanceError) as exc:
        roles = active_roles(request.user)
        return render(request, "rule_governance/error.html", {"error": str(exc), "code": exc.code, "permissions": permissions_for_roles(roles)}, status=exc.status)


@require_http_methods(["POST"])
def create_page(request):
    return page_action(request, "create")


@require_http_methods(["POST"])
def submit_page(request, package_id):
    return page_action(request, "submit", package_id)


@require_http_methods(["POST"])
def approve_page(request, package_id):
    return page_action(request, "approve", package_id)


@require_http_methods(["POST"])
def reject_page(request, package_id):
    return page_action(request, "reject", package_id)


@require_http_methods(["POST"])
def publish_page(request, package_id):
    return page_action(request, "publish", package_id)


@require_http_methods(["POST"])
def rollback_page(request, package_id):
    return page_action(request, "rollback", package_id)
