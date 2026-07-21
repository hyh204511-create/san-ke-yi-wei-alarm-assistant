import base64
import json
import logging
import uuid
from functools import wraps

from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_GET, require_http_methods

from apps.governance.services import active_roles, enterprise_scope_for_user, permissions_for_roles, require_permission

from . import services
from .models import ResponseAsset

logger = logging.getLogger("assistant.responses")


def json_payload(request):
    if not request.body:
        return {}
    if len(request.body) > 3 * 1024 * 1024:
        raise services.ResponseGovernanceError("请求体超过3MB限制", "PAYLOAD_TOO_LARGE", 413)
    try:
        value = json.loads(request.body)
    except json.JSONDecodeError as exc:
        raise services.ResponseGovernanceError("请求体不是有效JSON", "INVALID_JSON", 400) from exc
    if not isinstance(value, dict):
        raise services.ResponseGovernanceError("请求体必须是JSON对象", "INVALID_JSON", 400)
    return value


def public_id(value):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise services.ResponseGovernanceError("响应资产标识无效", "INVALID_IDENTIFIER", 400) from exc


def get_asset(value):
    asset = ResponseAsset.objects.select_related("created_by__assistant_profile", "reviewed_by__assistant_profile").prefetch_related("enterprise_scopes").filter(public_id=public_id(value)).first()
    if not asset:
        raise services.ResponseGovernanceError("响应资产不存在", "RESPONSE_ASSET_NOT_FOUND", 404)
    return asset


def api_view(handler):
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
        if not profile or not profile.is_active:
            return JsonResponse({"ok": False, "code": "AUTH_REQUIRED", "message": "请先登录有效的实名助手账号"}, status=401)
        try:
            return handler(request, *args, **kwargs)
        except services.ResponseGovernanceError as exc:
            return JsonResponse({"ok": False, "code": exc.code, "message": str(exc)}, status=exc.status, json_dumps_params={"ensure_ascii": False})
        except Exception:
            logger.exception("response_governance_api_error", extra={"path": request.path, "request_id": getattr(request, "request_id", "")})
            return JsonResponse({"ok": False, "code": "INTERNAL_ERROR", "message": "响应资产服务内部异常"}, status=500)
    return wrapped


def asset_data(asset, include_runtime=False):
    data = {
        "assetId": str(asset.public_id),
        "assetKey": asset.asset_key,
        "version": asset.version,
        "channelType": asset.channel_type,
        "status": asset.status,
        "contentHash": asset.content_hash,
        "changeNote": asset.change_note,
        "textTemplate": asset.text_template if asset.channel_type == ResponseAsset.ChannelType.TEXT else None,
        "voiceFilename": asset.voice_filename or None,
        "sampleRate": asset.sample_rate,
        "channels": asset.channels,
        "bitsPerSample": asset.bits_per_sample,
        "durationMs": asset.duration_ms,
        "createdBy": asset.created_by.assistant_profile.display_name,
        "reviewedBy": asset.reviewed_by.assistant_profile.display_name if asset.reviewed_by else None,
        "reviewComment": asset.review_comment,
        "publishedAt": asset.published_at.isoformat() if asset.published_at else None,
        "enterpriseScopes": [{"enterpriseId": str(scope.public_id), "enterpriseCode": scope.code, "enterpriseName": scope.name} for scope in asset.enterprise_scopes.all()],
    }
    if include_runtime and asset.channel_type == ResponseAsset.ChannelType.VOICE:
        data["voiceBase64"] = base64.b64encode(bytes(asset.voice_bytes)).decode("ascii")
    return data


@require_GET
def home(request):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    permissions = permissions_for_roles(active_roles(request.user))
    if not set(permissions).intersection({"rule.draft", "rule.review", "rule.publish"}):
        return render(request, "governance/access_denied.html", status=403)
    assets = ResponseAsset.objects.select_related("created_by__assistant_profile", "reviewed_by__assistant_profile").prefetch_related("enterprise_scopes")[:100]
    return render(request, "response_governance/home.html", {"profile": profile, "permissions": permissions, "assets": assets, "enterprise_scopes": enterprise_scope_for_user(request.user)})


@require_GET
@api_view
def list_api(request):
    permissions = permissions_for_roles(active_roles(request.user))
    if not set(permissions).intersection({"rule.draft", "rule.review", "rule.publish"}):
        raise services.ResponseGovernanceError("当前角色不能查看响应资产中心", "PERMISSION_DENIED", 403)
    assets = ResponseAsset.objects.select_related("created_by__assistant_profile", "reviewed_by__assistant_profile").prefetch_related("enterprise_scopes")[:100]
    return JsonResponse({"ok": True, "data": [asset_data(asset) for asset in assets], "limit": 100}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def create_api(request):
    data = json_payload(request)
    asset = services.create_draft(
        actor=request.user, asset_key=data.get("assetKey"), version=data.get("version"), channel_type=data.get("channelType"),
        enterprise_scope_ids=data.get("enterpriseScopeIds"), change_note=data.get("changeNote"), text_template=data.get("textTemplate"),
        voice_base64=data.get("voiceBase64"), voice_filename=data.get("voiceFilename"),
    )
    return JsonResponse({"ok": True, "data": asset_data(asset)}, status=201, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["PUT", "POST"])
@api_view
def update_api(request, asset_id):
    data = json_payload(request)
    asset = services.update_draft(
        actor=request.user, asset=get_asset(asset_id),
        enterprise_scope_ids=data.get("enterpriseScopeIds") if "enterpriseScopeIds" in data else None,
        change_note=data.get("changeNote") if "changeNote" in data else None,
        text_template=data.get("textTemplate") if "textTemplate" in data else None,
        voice_base64=data.get("voiceBase64") if "voiceBase64" in data else None,
        voice_filename=data.get("voiceFilename") if "voiceFilename" in data else None,
    )
    return JsonResponse({"ok": True, "data": asset_data(asset)}, json_dumps_params={"ensure_ascii": False})


def mutate(request, asset_id, operation):
    data = json_payload(request)
    asset = get_asset(asset_id)
    if operation == "submit":
        asset = services.submit_for_review(actor=request.user, asset=asset)
    elif operation == "approve":
        asset = services.review_asset(actor=request.user, asset=asset, approved=True, comment=data.get("comment"))
    elif operation == "reject":
        asset = services.review_asset(actor=request.user, asset=asset, approved=False, comment=data.get("comment"))
    elif operation == "publish":
        asset = services.publish_asset(actor=request.user, asset=asset)
    return JsonResponse({"ok": True, "data": asset_data(asset)}, json_dumps_params={"ensure_ascii": False})


@require_http_methods(["POST"])
@api_view
def submit_api(request, asset_id):
    return mutate(request, asset_id, "submit")


@require_http_methods(["POST"])
@api_view
def approve_api(request, asset_id):
    return mutate(request, asset_id, "approve")


@require_http_methods(["POST"])
@api_view
def reject_api(request, asset_id):
    return mutate(request, asset_id, "reject")


@require_http_methods(["POST"])
@api_view
def publish_api(request, asset_id):
    return mutate(request, asset_id, "publish")


@require_GET
@api_view
def runtime_api(request):
    try:
        require_permission(request.user, "rule.runtime")
    except Exception as exc:
        raise services.ResponseGovernanceError(str(exc), getattr(exc, "code", "PERMISSION_DENIED"), getattr(exc, "status", 403)) from exc
    assets = services.published_assets_for_actor(request.user)
    return JsonResponse({"ok": True, "data": [asset_data(asset, include_runtime=True) for asset in assets]}, json_dumps_params={"ensure_ascii": False})


def page_action(request, operation, asset_id=None):
    profile = getattr(request.user, "assistant_profile", None) if request.user.is_authenticated else None
    if not profile or not profile.is_active:
        return redirect("assistant-login")
    try:
        if operation == "create":
            voice = request.FILES.get("voice_file")
            services.create_draft(
                actor=request.user, asset_key=request.POST.get("asset_key"), version=request.POST.get("version"), channel_type=request.POST.get("channel_type"),
                enterprise_scope_ids=request.POST.getlist("enterprise_scope_ids"), change_note=request.POST.get("change_note"), text_template=request.POST.get("text_template"),
                voice_base64=base64.b64encode(voice.read()).decode("ascii") if voice else "", voice_filename=voice.name if voice else "",
            )
        else:
            asset = get_asset(asset_id)
            if operation == "submit": services.submit_for_review(actor=request.user, asset=asset)
            elif operation == "approve": services.review_asset(actor=request.user, asset=asset, approved=True, comment=request.POST.get("comment"))
            elif operation == "reject": services.review_asset(actor=request.user, asset=asset, approved=False, comment=request.POST.get("comment"))
            elif operation == "publish": services.publish_asset(actor=request.user, asset=asset)
        return redirect("response-asset-home")
    except services.ResponseGovernanceError as exc:
        return render(request, "rule_governance/error.html", {"error": str(exc), "code": exc.code, "permissions": permissions_for_roles(active_roles(request.user))}, status=exc.status)


@require_http_methods(["POST"])
def create_page(request): return page_action(request, "create")


@require_http_methods(["POST"])
def submit_page(request, asset_id): return page_action(request, "submit", asset_id)


@require_http_methods(["POST"])
def approve_page(request, asset_id): return page_action(request, "approve", asset_id)


@require_http_methods(["POST"])
def reject_page(request, asset_id): return page_action(request, "reject", asset_id)


@require_http_methods(["POST"])
def publish_page(request, asset_id): return page_action(request, "publish", asset_id)
