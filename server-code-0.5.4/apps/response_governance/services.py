import base64
import hashlib
import re
import struct
from string import Formatter

from django.db import transaction
from django.utils import timezone

from apps.governance.models import AuditEvent
from apps.governance.services import GovernanceError, enterprise_scope_for_user, enterprise_scope_ids_for_user, require_permission, select_authorized_enterprise_scopes

from .models import ResponseAsset, ResponseAssetEvent


ALLOWED_TEXT_VARIABLES = {"vehicleNo", "alarmName", "alarmTime", "companyName", "location"}
MAX_VOICE_BYTES = 2 * 1024 * 1024


class ResponseGovernanceError(Exception):
    def __init__(self, message, code="RESPONSE_GOVERNANCE_ERROR", status=400):
        super().__init__(message)
        self.code = code
        self.status = status


def require_response_permission(actor, permission):
    try:
        require_permission(actor, permission)
    except GovernanceError as exc:
        raise ResponseGovernanceError(str(exc), exc.code, exc.status) from exc


def validate_identifier(value, field_name):
    value = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", value):
        raise ResponseGovernanceError(f"{field_name}只能包含字母、数字、点、下划线和连字符", "INVALID_ASSET_IDENTIFIER", 422)
    return value


def authorized_scopes(actor, ids):
    try:
        return select_authorized_enterprise_scopes(actor, ids)
    except GovernanceError as exc:
        raise ResponseGovernanceError(str(exc), exc.code, exc.status) from exc


def require_asset_scope_access(actor, asset):
    scope_ids = set(asset.enterprise_scopes.values_list("pk", flat=True))
    if not scope_ids or not scope_ids.issubset(enterprise_scope_ids_for_user(actor)):
        raise ResponseGovernanceError("当前用户无权处理该响应资产的全部企业范围", "ENTERPRISE_SCOPE_DENIED", 403)


def validate_text_template(value):
    value = str(value or "").strip()
    if not value or len(value) > 500:
        raise ResponseGovernanceError("固定文本必须为1至500字符", "INVALID_TEXT_TEMPLATE", 422)
    try:
        fields = list(Formatter().parse(value))
    except ValueError as exc:
        raise ResponseGovernanceError("固定文本变量格式无效", "INVALID_TEXT_TEMPLATE", 422) from exc
    for _literal, field_name, format_spec, conversion in fields:
        if field_name is None:
            continue
        if field_name not in ALLOWED_TEXT_VARIABLES or format_spec or conversion:
            raise ResponseGovernanceError(f"固定文本包含未授权变量：{field_name}", "INVALID_TEXT_VARIABLE", 422)
    return value


def parse_pcm_wav(raw):
    if not isinstance(raw, (bytes, bytearray)) or len(raw) < 44 or len(raw) > MAX_VOICE_BYTES:
        raise ResponseGovernanceError("语音文件大小无效", "INVALID_VOICE_ASSET", 422)
    raw = bytes(raw)
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ResponseGovernanceError("语音文件不是有效WAV", "INVALID_VOICE_ASSET", 422)
    offset = 12
    fmt = None
    pcm = None
    while offset + 8 <= len(raw):
        chunk_id = raw[offset:offset + 4]
        size = struct.unpack_from("<I", raw, offset + 4)[0]
        start = offset + 8
        end = start + size
        if end > len(raw):
            raise ResponseGovernanceError("WAV区块长度无效", "INVALID_VOICE_ASSET", 422)
        if chunk_id == b"fmt " and size >= 16:
            fmt = struct.unpack_from("<HHIIHH", raw, start)
        elif chunk_id == b"data":
            pcm = raw[start:end]
        offset = end + size % 2
    if not fmt or pcm is None:
        raise ResponseGovernanceError("WAV缺少fmt或data区块", "INVALID_VOICE_ASSET", 422)
    audio_format, channels, sample_rate, _byte_rate, _block_align, bits = fmt
    if (audio_format, channels, sample_rate, bits) != (1, 1, 8000, 16):
        raise ResponseGovernanceError("语音必须是PCM、8kHz、16bit、单声道WAV", "INVALID_VOICE_FORMAT", 422)
    duration_ms = round(len(pcm) / (sample_rate * channels * bits / 8) * 1000)
    if duration_ms <= 0 or duration_ms > 60_000:
        raise ResponseGovernanceError("固定语音时长必须大于0且不超过60秒", "INVALID_VOICE_DURATION", 422)
    return {"raw": raw, "sample_rate": sample_rate, "channels": channels, "bits": bits, "duration_ms": duration_ms}


def decode_voice_base64(value):
    try:
        raw = base64.b64decode(str(value or ""), validate=True)
    except (ValueError, TypeError) as exc:
        raise ResponseGovernanceError("语音内容不是有效Base64", "INVALID_VOICE_ASSET", 422) from exc
    return parse_pcm_wav(raw)


def content_hash(channel_type, text_template="", voice_bytes=b""):
    material = text_template.encode("utf-8") if channel_type == ResponseAsset.ChannelType.TEXT else bytes(voice_bytes)
    return hashlib.sha256(channel_type.encode("ascii") + b"\0" + material).hexdigest()


def record_event(asset, action, actor, comment=""):
    ResponseAssetEvent.objects.create(asset=asset, action=action, actor=actor, comment=str(comment or "")[:1000], content_hash_snapshot=asset.content_hash)
    AuditEvent.objects.create(
        actor=actor,
        event_type=f"RESPONSE_ASSET_{action}",
        object_type="RESPONSE_ASSET",
        object_id=str(asset.public_id),
        role_snapshot=list(actor.assistant_roles.filter(is_active=True).values_list("role", flat=True)),
        enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"assetKey": asset.asset_key, "version": asset.version, "channelType": asset.channel_type, "status": asset.status, "contentHash": asset.content_hash},
    )


@transaction.atomic
def create_draft(*, actor, asset_key, version, channel_type, enterprise_scope_ids, change_note, text_template="", voice_base64="", voice_filename=""):
    require_response_permission(actor, "rule.draft")
    asset_key = validate_identifier(asset_key, "资产标识")
    version = validate_identifier(version, "版本号")
    if channel_type not in ResponseAsset.ChannelType.values:
        raise ResponseGovernanceError("响应渠道必须是TEXT或VOICE", "INVALID_CHANNEL_TYPE", 422)
    change_note = str(change_note or "").strip()
    if not change_note or len(change_note) > 500:
        raise ResponseGovernanceError("变更说明不能为空且不能超过500字符", "INVALID_CHANGE_NOTE", 422)
    if ResponseAsset.objects.filter(asset_key=asset_key, version=version).exists():
        raise ResponseGovernanceError("该响应资产版本已存在", "ASSET_VERSION_EXISTS", 409)
    existing_channel = ResponseAsset.objects.filter(asset_key=asset_key).values_list("channel_type", flat=True).first()
    if existing_channel and existing_channel != channel_type:
        raise ResponseGovernanceError("同一资产标识不能在文本和语音之间改变类型", "ASSET_CHANNEL_CONFLICT", 409)
    scopes = authorized_scopes(actor, enterprise_scope_ids)
    voice = None
    if channel_type == ResponseAsset.ChannelType.TEXT:
        text_template = validate_text_template(text_template)
        digest = content_hash(channel_type, text_template=text_template)
    else:
        voice = decode_voice_base64(voice_base64)
        digest = content_hash(channel_type, voice_bytes=voice["raw"])
    asset = ResponseAsset.objects.create(
        asset_key=asset_key,
        version=version,
        channel_type=channel_type,
        text_template=text_template if channel_type == ResponseAsset.ChannelType.TEXT else "",
        voice_bytes=voice["raw"] if voice else b"",
        voice_filename=str(voice_filename or "")[:255] if voice else "",
        voice_mime_type="audio/wav" if voice else "",
        sample_rate=voice["sample_rate"] if voice else None,
        channels=voice["channels"] if voice else None,
        bits_per_sample=voice["bits"] if voice else None,
        duration_ms=voice["duration_ms"] if voice else None,
        content_hash=digest,
        change_note=change_note,
        created_by=actor,
    )
    asset.enterprise_scopes.set(scopes)
    record_event(asset, ResponseAssetEvent.Action.CREATED, actor, change_note)
    return asset


@transaction.atomic
def update_draft(*, actor, asset, enterprise_scope_ids=None, change_note=None, text_template=None, voice_base64=None, voice_filename=None):
    require_response_permission(actor, "rule.draft")
    asset = ResponseAsset.objects.select_for_update().get(pk=asset.pk)
    require_asset_scope_access(actor, asset)
    if asset.status != ResponseAsset.Status.DRAFT or asset.created_by_id != actor.pk:
        raise ResponseGovernanceError("只能修改本人创建的响应资产草稿", "INVALID_ASSET_STATUS", 409)
    if change_note is not None:
        note = str(change_note or "").strip()
        if not note or len(note) > 500:
            raise ResponseGovernanceError("变更说明不能为空且不能超过500字符", "INVALID_CHANGE_NOTE", 422)
        asset.change_note = note
    if asset.channel_type == ResponseAsset.ChannelType.TEXT and text_template is not None:
        asset.text_template = validate_text_template(text_template)
        asset.content_hash = content_hash(asset.channel_type, text_template=asset.text_template)
    if asset.channel_type == ResponseAsset.ChannelType.VOICE and voice_base64 is not None:
        voice = decode_voice_base64(voice_base64)
        asset.voice_bytes = voice["raw"]
        asset.voice_filename = str(voice_filename or asset.voice_filename)[:255]
        asset.sample_rate = voice["sample_rate"]
        asset.channels = voice["channels"]
        asset.bits_per_sample = voice["bits"]
        asset.duration_ms = voice["duration_ms"]
        asset.content_hash = content_hash(asset.channel_type, voice_bytes=voice["raw"])
    asset.save(update_fields=["change_note", "text_template", "voice_bytes", "voice_filename", "sample_rate", "channels", "bits_per_sample", "duration_ms", "content_hash", "updated_at"])
    if enterprise_scope_ids is not None:
        asset.enterprise_scopes.set(authorized_scopes(actor, enterprise_scope_ids))
    record_event(asset, ResponseAssetEvent.Action.UPDATED, actor, asset.change_note)
    return asset


@transaction.atomic
def submit_for_review(*, actor, asset):
    require_response_permission(actor, "rule.submit")
    asset = ResponseAsset.objects.select_for_update().get(pk=asset.pk)
    require_asset_scope_access(actor, asset)
    if asset.status != ResponseAsset.Status.DRAFT or asset.created_by_id != actor.pk:
        raise ResponseGovernanceError("只能提交本人创建的响应资产草稿", "INVALID_ASSET_STATUS", 409)
    if asset.channel_type == ResponseAsset.ChannelType.TEXT:
        validate_text_template(asset.text_template)
    else:
        parse_pcm_wav(bytes(asset.voice_bytes))
    asset.status = ResponseAsset.Status.IN_REVIEW
    asset.submitted_at = timezone.now()
    asset.save(update_fields=["status", "submitted_at", "updated_at"])
    record_event(asset, ResponseAssetEvent.Action.SUBMITTED, actor, asset.change_note)
    return asset


@transaction.atomic
def review_asset(*, actor, asset, approved, comment):
    require_response_permission(actor, "rule.approve" if approved else "rule.reject")
    asset = ResponseAsset.objects.select_for_update().get(pk=asset.pk)
    require_asset_scope_access(actor, asset)
    if asset.status != ResponseAsset.Status.IN_REVIEW:
        raise ResponseGovernanceError("响应资产当前不在审核中", "INVALID_ASSET_STATUS", 409)
    if asset.created_by_id == actor.pk:
        raise ResponseGovernanceError("响应资产配置人不能审核本人版本", "REVIEWER_SEPARATION_VIOLATION", 409)
    comment = str(comment or "").strip()
    if not comment or len(comment) > 1000:
        raise ResponseGovernanceError("审核意见不能为空且不能超过1000字符", "INVALID_REVIEW_COMMENT", 422)
    asset.status = ResponseAsset.Status.APPROVED if approved else ResponseAsset.Status.REJECTED
    asset.reviewed_by = actor
    asset.reviewed_at = timezone.now()
    asset.review_comment = comment
    asset.save(update_fields=["status", "reviewed_by", "reviewed_at", "review_comment", "updated_at"])
    record_event(asset, ResponseAssetEvent.Action.APPROVED if approved else ResponseAssetEvent.Action.REJECTED, actor, comment)
    return asset


@transaction.atomic
def publish_asset(*, actor, asset):
    require_response_permission(actor, "rule.publish")
    asset = ResponseAsset.objects.select_for_update().get(pk=asset.pk)
    require_asset_scope_access(actor, asset)
    if asset.status != ResponseAsset.Status.APPROVED or not asset.reviewed_by_id or asset.reviewed_by_id == asset.created_by_id:
        raise ResponseGovernanceError("响应资产必须由不同人员审核通过后才能发布", "INVALID_ASSET_STATUS", 409)
    now = timezone.now()
    previous = ResponseAsset.objects.select_for_update().filter(asset_key=asset.asset_key, channel_type=asset.channel_type, status=ResponseAsset.Status.PUBLISHED).exclude(pk=asset.pk)
    for current in previous:
        current.status = ResponseAsset.Status.RETIRED
        current.retired_at = now
        current.save(update_fields=["status", "retired_at", "updated_at"])
        record_event(current, ResponseAssetEvent.Action.RETIRED, actor, f"由版本 {asset.version} 替代")
    asset.status = ResponseAsset.Status.PUBLISHED
    asset.published_at = now
    asset.save(update_fields=["status", "published_at", "updated_at"])
    record_event(asset, ResponseAssetEvent.Action.PUBLISHED, actor, asset.review_comment)
    return asset


def published_assets_for_actor(actor, keys=None):
    allowed = enterprise_scope_ids_for_user(actor)
    queryset = ResponseAsset.objects.filter(status=ResponseAsset.Status.PUBLISHED, enterprise_scopes__in=allowed).distinct().prefetch_related("enterprise_scopes")
    if keys is not None:
        queryset = queryset.filter(asset_key__in=set(keys))
    return list(queryset)


def runtime_asset_payload(asset):
    payload = {
        "assetKey": asset.asset_key,
        "version": asset.version,
        "channelType": asset.channel_type,
        "contentHash": asset.content_hash,
        "enterpriseScopeIds": [str(scope.public_id) for scope in asset.enterprise_scopes.all()],
    }
    if asset.channel_type == ResponseAsset.ChannelType.TEXT:
        payload["textTemplate"] = asset.text_template
    else:
        payload.update({
            "voiceBase64": base64.b64encode(bytes(asset.voice_bytes)).decode("ascii"),
            "voiceFilename": asset.voice_filename,
            "sampleRate": asset.sample_rate,
            "channels": asset.channels,
            "bitsPerSample": asset.bits_per_sample,
            "durationMs": asset.duration_ms,
        })
    return payload


def validate_published_assets_for_rule_package(package):
    package_scope_ids = set(package.enterprise_scopes.values_list("pk", flat=True))
    references = []
    for rule in package.payload.get("rules", []):
        if not rule.get("enabled"):
            continue
        for channel in rule.get("channels") or []:
            if channel.get("type") == "TEXT":
                references.append((channel.get("templateId"), ResponseAsset.ChannelType.TEXT, rule.get("id")))
            elif channel.get("type") == "VOICE":
                references.append((channel.get("assetId"), ResponseAsset.ChannelType.VOICE, rule.get("id")))
    errors = []
    for key, channel_type, rule_id in references:
        asset = ResponseAsset.objects.filter(asset_key=key, channel_type=channel_type, status=ResponseAsset.Status.PUBLISHED).prefetch_related("enterprise_scopes").first()
        if not asset:
            errors.append(f"规则 {rule_id} 引用的{channel_type}资产未发布: {key}")
            continue
        asset_scope_ids = set(asset.enterprise_scopes.values_list("pk", flat=True))
        if not package_scope_ids.issubset(asset_scope_ids):
            errors.append(f"规则 {rule_id} 的资产 {key} 未覆盖规则包全部企业范围")
    if errors:
        raise ResponseGovernanceError("规则引用的响应资产校验失败：" + "；".join(errors), "RESPONSE_ASSET_NOT_READY", 409)
    return True
