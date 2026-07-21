import copy
import re

from django.db import transaction
from django.utils import timezone

from apps.governance.models import AuditEvent
from apps.governance.services import GovernanceError, enterprise_scope_for_user, enterprise_scope_ids_for_user, require_permission, select_authorized_enterprise_scopes

from .models import RulePackage, RuleReviewEvent
from .validation import RulePayloadValidationError, payload_hash, validate_rule_payload


class RuleGovernanceError(Exception):
    def __init__(self, message, code="RULE_GOVERNANCE_ERROR", status=400, errors=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.errors = errors or []


def require_rule_permission(actor, permission):
    try:
        return require_permission(actor, permission)
    except GovernanceError as exc:
        raise RuleGovernanceError(str(exc), exc.code, exc.status) from exc


def validate_version(version):
    version = str(version or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", version):
        raise RuleGovernanceError("版本号只能包含字母、数字、点、下划线和连字符", "INVALID_VERSION")
    return version


def validate_payload_for_submission(payload):
    try:
        validate_rule_payload(payload)
    except RulePayloadValidationError as exc:
        raise RuleGovernanceError("规则包校验失败", "RULE_VALIDATION_FAILED", 422, exc.errors) from exc
    return payload_hash(payload)


def authorized_enterprise_scopes(actor, enterprise_scope_ids):
    try:
        return select_authorized_enterprise_scopes(actor, enterprise_scope_ids)
    except GovernanceError as exc:
        raise RuleGovernanceError(str(exc), exc.code, exc.status) from exc


def require_package_scope_access(actor, package):
    scope_ids = set(package.enterprise_scopes.values_list("pk", flat=True))
    if not scope_ids:
        raise RuleGovernanceError("规则包没有明确企业范围", "ENTERPRISE_SCOPE_REQUIRED", 409)
    if not scope_ids.issubset(enterprise_scope_ids_for_user(actor)):
        raise RuleGovernanceError("当前用户无权处理该规则包的全部企业范围", "ENTERPRISE_SCOPE_DENIED", 403)
    return scope_ids


def require_package_scope_intersection(actor, package):
    scope_ids = set(package.enterprise_scopes.values_list("pk", flat=True))
    if not scope_ids:
        raise RuleGovernanceError("规则包没有明确企业范围", "ENTERPRISE_SCOPE_REQUIRED", 409)
    if not scope_ids.intersection(enterprise_scope_ids_for_user(actor)):
        raise RuleGovernanceError("当前用户无权读取该规则包", "ENTERPRISE_SCOPE_DENIED", 403)
    return scope_ids


def record_event(rule_package, action, actor, comment=""):
    return RuleReviewEvent.objects.create(
        rule_package=rule_package,
        action=action,
        actor=actor,
        comment=str(comment or "")[:1000],
        content_hash_snapshot=rule_package.content_hash or payload_hash(rule_package.payload),
    )


def record_audit(rule_package, event_type, actor, detail=None, request_id=""):
    return AuditEvent.objects.create(
        actor=actor,
        event_type=event_type,
        object_type="RULE_PACKAGE",
        object_id=str(rule_package.public_id),
        role_snapshot=list(actor.assistant_roles.filter(is_active=True).values_list("role", flat=True)),
        enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"version": rule_package.version, "status": rule_package.status, "contentHash": rule_package.content_hash, **(detail or {})},
        request_id=request_id,
    )


@transaction.atomic
def create_draft(*, actor, version, payload, change_note, enterprise_scope_ids, based_on=None, request_id=""):
    require_rule_permission(actor, "rule.draft")
    version = validate_version(version)
    if not isinstance(payload, dict):
        raise RuleGovernanceError("规则包必须是JSON对象", "INVALID_PAYLOAD")
    change_note = str(change_note or "").strip()
    if not change_note or len(change_note) > 500:
        raise RuleGovernanceError("变更说明不能为空且不能超过500字符", "INVALID_CHANGE_NOTE")
    if RulePackage.objects.filter(version=version).exists():
        raise RuleGovernanceError("规则版本已存在", "VERSION_EXISTS", 409)
    scopes = authorized_enterprise_scopes(actor, enterprise_scope_ids)
    stored_payload = copy.deepcopy(payload)
    stored_payload["version"] = version
    package = RulePackage.objects.create(
        version=version,
        payload=stored_payload,
        content_hash=payload_hash(stored_payload),
        change_note=change_note,
        created_by=actor,
        based_on=based_on,
    )
    package.enterprise_scopes.set(scopes)
    record_event(package, RuleReviewEvent.Action.CREATED, actor, change_note)
    record_audit(package, "RULE_DRAFT_CREATED", actor, request_id=request_id)
    return package


@transaction.atomic
def update_draft(*, actor, package, payload, change_note=None, enterprise_scope_ids=None, request_id=""):
    require_rule_permission(actor, "rule.draft")
    package = RulePackage.objects.select_for_update().get(pk=package.pk)
    if package.status != RulePackage.Status.DRAFT:
        raise RuleGovernanceError("只有草稿状态可以修改", "RULE_IMMUTABLE", 409)
    if package.created_by_id != actor.pk:
        raise RuleGovernanceError("只能修改本人创建的规则草稿", "PERMISSION_DENIED", 403)
    require_package_scope_access(actor, package)
    if not isinstance(payload, dict):
        raise RuleGovernanceError("规则包必须是JSON对象", "INVALID_PAYLOAD")
    stored_payload = copy.deepcopy(payload)
    stored_payload["version"] = package.version
    package.payload = stored_payload
    package.content_hash = payload_hash(stored_payload)
    if change_note is not None:
        note = str(change_note).strip()
        if not note or len(note) > 500:
            raise RuleGovernanceError("变更说明不能为空且不能超过500字符", "INVALID_CHANGE_NOTE")
        package.change_note = note
    package.save(update_fields=["payload", "content_hash", "change_note", "updated_at"])
    if enterprise_scope_ids is not None:
        package.enterprise_scopes.set(authorized_enterprise_scopes(actor, enterprise_scope_ids))
    record_event(package, RuleReviewEvent.Action.UPDATED, actor, package.change_note)
    record_audit(package, "RULE_DRAFT_UPDATED", actor, request_id=request_id)
    return package


@transaction.atomic
def submit_for_review(*, actor, package, request_id=""):
    require_rule_permission(actor, "rule.submit")
    package = RulePackage.objects.select_for_update().get(pk=package.pk)
    if package.status != RulePackage.Status.DRAFT:
        raise RuleGovernanceError("只有草稿可以提交审核", "INVALID_RULE_STATUS", 409)
    if package.created_by_id != actor.pk:
        raise RuleGovernanceError("只能提交本人创建的规则草稿", "PERMISSION_DENIED", 403)
    require_package_scope_access(actor, package)
    package.content_hash = validate_payload_for_submission(package.payload)
    package.status = RulePackage.Status.IN_REVIEW
    package.submitted_at = timezone.now()
    package.reviewed_by = None
    package.reviewed_at = None
    package.review_comment = ""
    package.save(update_fields=["content_hash", "status", "submitted_at", "reviewed_by", "reviewed_at", "review_comment", "updated_at"])
    record_event(package, RuleReviewEvent.Action.SUBMITTED, actor, package.change_note)
    record_audit(package, "RULE_SUBMITTED", actor, request_id=request_id)
    return package


@transaction.atomic
def review_package(*, actor, package, approved, comment, request_id=""):
    require_rule_permission(actor, "rule.approve" if approved else "rule.reject")
    package = RulePackage.objects.select_for_update().get(pk=package.pk)
    if package.status != RulePackage.Status.IN_REVIEW:
        raise RuleGovernanceError("规则包当前不在审核中", "INVALID_RULE_STATUS", 409)
    if package.created_by_id == actor.pk:
        raise RuleGovernanceError("规则配置人不能审核本人提交的版本", "REVIEWER_SEPARATION_VIOLATION", 409)
    require_package_scope_access(actor, package)
    comment = str(comment or "").strip()
    if not comment or len(comment) > 1000:
        raise RuleGovernanceError("审核意见不能为空且不能超过1000字符", "INVALID_REVIEW_COMMENT")
    current_hash = validate_payload_for_submission(package.payload)
    if current_hash != package.content_hash:
        raise RuleGovernanceError("提交后的规则内容发生变化，必须重新生成草稿", "RULE_CONTENT_CHANGED", 409)
    package.status = RulePackage.Status.APPROVED if approved else RulePackage.Status.REJECTED
    package.reviewed_by = actor
    package.reviewed_at = timezone.now()
    package.review_comment = comment
    package.save(update_fields=["status", "reviewed_by", "reviewed_at", "review_comment", "updated_at"])
    action = RuleReviewEvent.Action.APPROVED if approved else RuleReviewEvent.Action.REJECTED
    record_event(package, action, actor, comment)
    record_audit(package, "RULE_APPROVED" if approved else "RULE_REJECTED", actor, {"comment": comment}, request_id)
    return package


@transaction.atomic
def publish_package(*, actor, package, request_id=""):
    require_rule_permission(actor, "rule.publish")
    package = RulePackage.objects.select_for_update().get(pk=package.pk)
    if package.status != RulePackage.Status.APPROVED:
        raise RuleGovernanceError("只有已批准规则包可以发布", "INVALID_RULE_STATUS", 409)
    require_package_scope_access(actor, package)
    if not package.reviewed_by_id or package.reviewed_by_id == package.created_by_id:
        raise RuleGovernanceError("发布前必须完成配置人与审核人分离", "REVIEWER_SEPARATION_VIOLATION", 409)
    from apps.response_governance.services import ResponseGovernanceError, validate_published_assets_for_rule_package
    try:
        validate_published_assets_for_rule_package(package)
    except ResponseGovernanceError as exc:
        raise RuleGovernanceError(str(exc), exc.code, exc.status) from exc
    now = timezone.now()
    previous = list(RulePackage.objects.select_for_update().filter(status=RulePackage.Status.PUBLISHED).exclude(pk=package.pk))
    for current in previous:
        current.status = RulePackage.Status.RETIRED
        current.retired_at = now
        current.save(update_fields=["status", "retired_at", "updated_at"])
        record_event(current, RuleReviewEvent.Action.RETIRED, actor, f"由版本 {package.version} 替代")
        record_audit(current, "RULE_RETIRED", actor, {"replacementVersion": package.version}, request_id)
    package.status = RulePackage.Status.PUBLISHED
    package.published_at = now
    package.retired_at = None
    package.save(update_fields=["status", "published_at", "retired_at", "updated_at"])
    record_event(package, RuleReviewEvent.Action.PUBLISHED, actor, package.review_comment)
    record_audit(package, "RULE_PUBLISHED", actor, request_id=request_id)
    return package


@transaction.atomic
def rollback_to_package(*, actor, target, new_version, comment, request_id=""):
    require_rule_permission(actor, "rule.publish")
    target = RulePackage.objects.select_for_update().get(pk=target.pk)
    if target.status not in {RulePackage.Status.PUBLISHED, RulePackage.Status.RETIRED}:
        raise RuleGovernanceError("只能回滚到已发布过的规则版本", "INVALID_ROLLBACK_TARGET", 409)
    require_package_scope_access(actor, target)
    if target.created_by_id == actor.pk:
        raise RuleGovernanceError("规则配置人不能单独完成回滚发布", "REVIEWER_SEPARATION_VIOLATION", 409)
    new_version = validate_version(new_version)
    if RulePackage.objects.filter(version=new_version).exists():
        raise RuleGovernanceError("回滚版本号已存在", "VERSION_EXISTS", 409)
    comment = str(comment or "").strip()
    if not comment or len(comment) > 1000:
        raise RuleGovernanceError("回滚原因不能为空且不能超过1000字符", "INVALID_REVIEW_COMMENT")
    now = timezone.now()
    for current in RulePackage.objects.select_for_update().filter(status=RulePackage.Status.PUBLISHED):
        current.status = RulePackage.Status.RETIRED
        current.retired_at = now
        current.save(update_fields=["status", "retired_at", "updated_at"])
        record_event(current, RuleReviewEvent.Action.RETIRED, actor, f"回滚到 {target.version}")
    payload = copy.deepcopy(target.payload)
    payload["version"] = new_version
    package = RulePackage.objects.create(
        version=new_version,
        status=RulePackage.Status.PUBLISHED,
        payload=payload,
        content_hash=payload_hash(payload),
        change_note=f"回滚自 {target.version}: {comment}"[:500],
        created_by=target.created_by,
        submitted_at=now,
        reviewed_by=actor,
        reviewed_at=now,
        review_comment=comment,
        published_at=now,
        based_on=target,
        rollback_of=target,
    )
    package.enterprise_scopes.set(target.enterprise_scopes.all())
    record_event(package, RuleReviewEvent.Action.ROLLED_BACK, actor, comment)
    record_event(package, RuleReviewEvent.Action.PUBLISHED, actor, comment)
    record_audit(package, "RULE_ROLLED_BACK", actor, {"targetVersion": target.version}, request_id)
    return package


def published_package(actor=None):
    package = RulePackage.objects.filter(status=RulePackage.Status.PUBLISHED).select_related("created_by", "reviewed_by").prefetch_related("enterprise_scopes").first()
    if package and actor is not None:
        require_package_scope_intersection(actor, package)
    return package


def legacy_runtime_rule_set(package):
    if not package or package.status != RulePackage.Status.PUBLISHED:
        raise RuleGovernanceError("当前没有已发布规则包", "PUBLISHED_RULE_NOT_FOUND", 404)
    legacy_rules = []
    deferred_channels = []
    for rule in package.payload.get("rules", []):
        handling_mode = rule.get("handlingMode")
        channels = sorted(rule.get("channels") or [], key=lambda item: item.get("order", 0))
        voice_channels = [channel for channel in channels if channel.get("type") == "VOICE"]
        text_channels = [channel for channel in channels if channel.get("type") == "TEXT"]
        action = "MANUAL_REVIEW"
        voice = voice_channels[0] if voice_channels else {}
        if handling_mode == "RECORD_ONLY":
            action = "RECORD_ONLY"
        elif handling_mode == "DISABLED":
            action = "DISABLED"
        elif handling_mode == "AUTO" and (voice_channels or text_channels):
            deferred_channels.append(rule.get("id"))
        legacy_rules.append({
            "id": rule.get("id"),
            "name": rule.get("name") or rule.get("id"),
            "enabled": bool(rule.get("enabled")),
            "approvalStatus": "CONFIRMED",
            "priority": rule.get("priority", 0),
            "match": copy.deepcopy(rule.get("match") or {}),
            "action": action,
            "voiceTemplateId": voice.get("templateId"),
            "audioAssetId": voice.get("assetId"),
            "allowRealIntercom": False,
            "requireVehicleAllowlist": True,
            "failureAction": "MANUAL_REVIEW",
            "changeNote": "由服务端已发布Schema V2规则包生成；文本和语音资产适配完成前明确转人工",
        })
    return {
        "schemaVersion": 1,
        "version": package.version,
        "status": "CONFIRMED",
        "contentHash": package.content_hash,
        "publishedAt": package.published_at.isoformat() if package.published_at else None,
        "runtimeCompatibility": {
            "sourceSchemaVersion": 2,
            "textChannelAdapterReady": False,
            "voiceChannelAdapterReady": False,
            "deferredChannelRuleIds": [item for item in deferred_channels if item],
        },
        "rules": legacy_rules,
    }


def native_runtime_rule_set(package):
    if not package or package.status != RulePackage.Status.PUBLISHED:
        raise RuleGovernanceError("当前没有已发布规则包", "PUBLISHED_RULE_NOT_FOUND", 404)
    payload = copy.deepcopy(package.payload)
    payload.update({
        "schemaVersion": 2,
        "version": package.version,
        "status": "PUBLISHED",
        "contentHash": package.content_hash,
        "publishedAt": package.published_at.isoformat() if package.published_at else None,
        "allowLiveActions": False,
    })
    return payload
