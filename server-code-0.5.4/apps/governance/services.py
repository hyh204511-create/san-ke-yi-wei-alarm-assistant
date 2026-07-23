from datetime import datetime, timedelta
import hashlib
import re

from django.db import transaction
from django.core.exceptions import ValidationError
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.utils import timezone

from .models import (
    AssistantProfile, AuditEvent, DeviceRegistration, DutyShift, EnterpriseGrant, EnterpriseScope,
    RoleAssignment, SessionKeepaliveAudit, SessionKeepalivePolicy, VoiceInteractionPolicy,
)


class GovernanceError(Exception):
    def __init__(self, message, code="GOVERNANCE_ERROR", status=400):
        super().__init__(message)
        self.code = code
        self.status = status


ROLE_PERMISSIONS = {
    # Unit collectors can observe authorized alarm data and perform the
    # low-frequency, fixed-route session keepalive. They cannot create,
    # publish, export reports, edit rules, or execute business actions.
    RoleAssignment.Role.UNIT_USER: {
        "alarm.view", "rule.runtime", "session.keepalive.execute",
    },
    # Separate role for staff who are allowed to take over a case or execute
    # an approved live action. It cannot be combined with collection,
    # rule configuration, or rule review roles.
    RoleAssignment.Role.MONITOR_OPERATOR: {
        "alarm.view", "disposal.takeover", "disposal.note", "disposal.complete",
        "action.execute", "action.retry", "rule.runtime", "session.keepalive.execute",
        "report.view", "report.collect", "evidence.view",
    },
    # Rule configurers may draft and submit rules. Review and publication stay
    # with the separated rule reviewer role.
    RoleAssignment.Role.RULE_CONFIGURER: {
        "alarm.view", "rule.draft", "rule.submit",
    },
    RoleAssignment.Role.RULE_REVIEWER: {
        "alarm.view", "disposal.note", "disposal.review", "disposal.close",
        "disposal.reopen", "action.retry", "rule.review", "rule.approve",
        "rule.reject", "rule.publish", "audit.view", "evidence.request",
        "evidence.view", "evidence.review", "evidence.download",
    },
    # Only system administrators can create/publish report snapshots and
    # generate or download report exports. This is enforced at the service
    # boundary as well as in the templates.
    RoleAssignment.Role.SYSTEM_ADMIN: {
        "identity.manage", "enterprise.manage", "system.configure", "audit.view",
        "report.view", "report.generate", "report.publish", "export.masked",
        "evidence.view", "evidence.review",
    },
}

KEEPALIVE_RESULT_CODES = {
    "SUCCESS", "DISABLED", "IDENTITY_REQUIRED", "SHIFT_REQUIRED", "PERMISSION_DENIED",
    "PLATFORM_TAB_NOT_FOUND", "LOGIN_REQUIRED", "ROUTE_NOT_APPROVED", "CHALLENGE_DETECTED",
    "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "OVERLAP_SKIPPED", "COOLDOWN_ACTIVE", "POLICY_UNAVAILABLE",
}

# The server publishes this fixed allowlist. Clients cannot choose arbitrary
# routes or selectors; only the preprocessing query may click, while the
# monitor and prewarning pages are read-only observations.
KEEPALIVE_TARGETS = (
    {
        "route": SessionKeepalivePolicy.TARGET_ROUTE,
        "actionKey": SessionKeepalivePolicy.TARGET_ACTION_KEY,
        "mode": "CLICK_QUERY",
    },
    {
        "route": "#/vehicle-monitor/real-time",
        "actionKey": "REALTIME_MONITOR_OBSERVE",
        "mode": "READ_ONLY_OBSERVE",
    },
    {
        "route": "#/alarm-center/pr-alarm-recorde",
        "actionKey": "PREWARNING_LIST_OBSERVE",
        "mode": "READ_ONLY_OBSERVE",
    },
)

PLATFORM_IDENTITY_STATUSES = {"UNKNOWN", "UNVERIFIED", "VERIFIED"}


def safe_platform_route(value):
    route = str(value or "").split("?", 1)[0][:200]
    return route if re.fullmatch(r"#/[A-Za-z0-9_./-]*", route) else ""


def keepalive_policy():
    policy, _ = SessionKeepalivePolicy.objects.get_or_create(key=SessionKeepalivePolicy.SINGLETON_KEY)
    return policy


def keepalive_policy_payload(policy):
    return {
        "enabled": policy.enabled,
        "intervalMinutes": policy.interval_minutes,
        "targetRoute": policy.target_route,
        "targetActionKey": policy.target_action_key,
        "allowedTargets": [dict(target) for target in KEEPALIVE_TARGETS],
        "version": policy.version,
        "updatedAt": policy.updated_at.isoformat(),
    }


def voice_interaction_policy():
    policy, _ = VoiceInteractionPolicy.objects.get_or_create(key=VoiceInteractionPolicy.SINGLETON_KEY)
    return policy


def voice_interaction_policy_payload(policy):
    return {
        "enabled": policy.enabled,
        "recordDriverAudio": policy.record_driver_audio,
        "transcribeDriverAudio": policy.transcribe_driver_audio,
        "consentRequired": policy.consent_required,
        "retentionDays": policy.retention_days,
        "version": policy.version,
        "updatedAt": policy.updated_at.isoformat(),
    }


@transaction.atomic
def update_voice_interaction_policy(*, actor, enabled, record_driver_audio, transcribe_driver_audio, retention_days, request_id=""):
    require_permission(actor, "system.configure")
    if not isinstance(enabled, bool) or not isinstance(record_driver_audio, bool) or not isinstance(transcribe_driver_audio, bool):
        raise GovernanceError("语音证据策略开关必须是布尔值", "INVALID_VOICE_POLICY", 422)
    try:
        retention = int(retention_days)
    except (TypeError, ValueError) as exc:
        raise GovernanceError("语音证据保留天数必须是1至365的整数", "INVALID_VOICE_POLICY", 422) from exc
    if retention < 1 or retention > 365:
        raise GovernanceError("语音证据保留天数必须介于1至365天", "INVALID_VOICE_POLICY", 422)
    if (record_driver_audio or transcribe_driver_audio) and not enabled:
        raise GovernanceError("未启用语音证据策略时不能开启录音或转写", "INVALID_VOICE_POLICY", 422)
    policy = VoiceInteractionPolicy.objects.select_for_update().filter(key=VoiceInteractionPolicy.SINGLETON_KEY).first()
    if not policy:
        policy = VoiceInteractionPolicy(key=VoiceInteractionPolicy.SINGLETON_KEY)
    changed = (
        policy.enabled != enabled or policy.record_driver_audio != record_driver_audio
        or policy.transcribe_driver_audio != transcribe_driver_audio or policy.retention_days != retention
    )
    policy.enabled = enabled
    policy.record_driver_audio = record_driver_audio
    policy.transcribe_driver_audio = transcribe_driver_audio
    policy.retention_days = retention
    policy.updated_by = actor
    if policy.pk and changed:
        policy.version += 1
    policy.full_clean()
    policy.save()
    AuditEvent.objects.create(
        actor=actor, event_type="VOICE_INTERACTION_POLICY_UPDATED", object_type="VOICE_INTERACTION_POLICY",
        object_id=policy.key, role_snapshot=active_roles(actor), enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"enabled": enabled, "recordDriverAudio": record_driver_audio, "transcribeDriverAudio": transcribe_driver_audio, "retentionDays": retention, "version": policy.version},
        request_id=request_id,
    )
    return policy


@transaction.atomic
def update_keepalive_policy(*, actor, enabled, interval_minutes, request_id=""):
    require_permission(actor, "system.configure")
    try:
        interval = int(interval_minutes)
    except (TypeError, ValueError) as exc:
        raise GovernanceError("保活间隔必须是20至50分钟的整数", "INVALID_KEEPALIVE_INTERVAL", 422) from exc
    if interval < 20 or interval > 50:
        raise GovernanceError("保活间隔必须介于20至50分钟", "INVALID_KEEPALIVE_INTERVAL", 422)
    policy = SessionKeepalivePolicy.objects.select_for_update().filter(key=SessionKeepalivePolicy.SINGLETON_KEY).first()
    if not policy:
        policy = SessionKeepalivePolicy(key=SessionKeepalivePolicy.SINGLETON_KEY)
    changed = policy.enabled != bool(enabled) or policy.interval_minutes != interval
    policy.enabled = bool(enabled)
    policy.interval_minutes = interval
    policy.target_route = SessionKeepalivePolicy.TARGET_ROUTE
    policy.target_action_key = SessionKeepalivePolicy.TARGET_ACTION_KEY
    policy.updated_by = actor
    if policy.pk and changed:
        policy.version += 1
    policy.full_clean()
    policy.save()
    AuditEvent.objects.create(
        actor=actor, event_type="SESSION_KEEPALIVE_POLICY_UPDATED", object_type="SESSION_KEEPALIVE_POLICY",
        object_id=policy.key, role_snapshot=active_roles(actor), enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"enabled": policy.enabled, "intervalMinutes": policy.interval_minutes, "version": policy.version},
        request_id=request_id,
    )
    return policy


def normalize_platform_context(value):
    """Accept only non-secret identity signals observed by the browser page.

    The province platform credentials and raw page content never cross this boundary.
    """
    if value is None:
        return {
            "display_name": "",
            "identity_status": "UNKNOWN",
            "visible_scope_hash": "",
            "permission_summary": {},
        }
    if not isinstance(value, dict):
        raise GovernanceError("省平台身份上下文必须是对象", "INVALID_PLATFORM_CONTEXT", 422)
    allowed = {"displayName", "identityStatus", "visibleScopeHash", "permissionSummary"}
    if set(value) - allowed:
        raise GovernanceError("省平台身份上下文包含未允许字段", "INVALID_PLATFORM_CONTEXT", 422)
    identity_status = str(value.get("identityStatus") or "UNKNOWN").upper()
    if identity_status not in PLATFORM_IDENTITY_STATUSES:
        raise GovernanceError("省平台身份状态无效", "INVALID_PLATFORM_CONTEXT", 422)
    display_name = str(value.get("displayName") or "").strip()
    if len(display_name) > 100:
        raise GovernanceError("省平台显示姓名过长", "INVALID_PLATFORM_CONTEXT", 422)
    scope_hash = str(value.get("visibleScopeHash") or "").strip().lower()
    if scope_hash and not re.fullmatch(r"[0-9a-f]{64}", scope_hash):
        raise GovernanceError("省平台可见范围摘要必须是SHA-256", "INVALID_PLATFORM_CONTEXT", 422)
    summary = value.get("permissionSummary") or {}
    if not isinstance(summary, dict) or len(summary) > 50:
        raise GovernanceError("省平台权限摘要无效", "INVALID_PLATFORM_CONTEXT", 422)
    safe_summary = {}
    for key, item in summary.items():
        key = str(key)
        if len(key) > 80 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", key):
            raise GovernanceError("省平台权限摘要键无效", "INVALID_PLATFORM_CONTEXT", 422)
        if not isinstance(item, (bool, int, float, str)):
            raise GovernanceError("省平台权限摘要值无效", "INVALID_PLATFORM_CONTEXT", 422)
        safe_summary[key] = str(item)[:120] if isinstance(item, str) else item
    return {
        "display_name": display_name,
        "identity_status": identity_status,
        "visible_scope_hash": scope_hash,
        "permission_summary": safe_summary,
    }


@transaction.atomic
def register_device_heartbeat(*, actor, device_id, extension_version, platform_account_ref, session_status, route, platform_context=None):
    require_permission(actor, "session.keepalive.execute")
    shift = active_shift_for_user(actor)
    if not shift:
        raise GovernanceError("请先认领当前值班班次", "ACTIVE_SHIFT_REQUIRED", 409)
    device_id = str(device_id or "").strip()
    if not device_id or len(device_id) > 120:
        raise GovernanceError("设备标识无效", "INVALID_DEVICE_ID", 422)
    if platform_account_ref and str(platform_account_ref) != shift.platform_account_ref:
        raise GovernanceError("设备上报的平台账号引用与当前班次不一致", "PLATFORM_ACCOUNT_MISMATCH", 409)
    existing_account_device = DeviceRegistration.objects.select_for_update().filter(
        platform_account_ref=shift.platform_account_ref, is_active=True,
    ).exclude(device_id=device_id).first()
    if existing_account_device:
        stale_before = timezone.now() - timedelta(minutes=2)
        if existing_account_device.user_id != actor.pk or existing_account_device.last_seen_at >= stale_before:
            raise GovernanceError("同一省平台账号不能同时由多个设备使用", "PLATFORM_ACCOUNT_DEVICE_CONFLICT", 409)
        from apps.reporting.models import ActionLease
        if ActionLease.objects.filter(
            device_id=existing_account_device.device_id,
            status__in=[ActionLease.Status.ACTIVE, ActionLease.Status.EXECUTING],
        ).exists():
            raise GovernanceError("旧设备仍有未完成动作，禁止接管省平台账号", "PLATFORM_ACCOUNT_DEVICE_CONFLICT", 409)
        stale_seconds = max(0, int((timezone.now() - existing_account_device.last_seen_at).total_seconds()))
        existing_account_device.is_active = False
        existing_account_device.save(update_fields=["is_active", "updated_at"])
    defaults = {
        "user": actor, "platform_account_ref": shift.platform_account_ref,
        "extension_version": str(extension_version or "")[:40], "session_status": str(session_status or "UNKNOWN")[:40],
        "last_route": safe_platform_route(route), "last_seen_at": timezone.now(), "is_active": True,
    }
    if platform_context is not None:
        context = normalize_platform_context(platform_context)
        defaults.update({
            "platform_display_name": context["display_name"],
            "platform_identity_status": context["identity_status"],
            "platform_visible_scope_hash": context["visible_scope_hash"],
            "platform_permission_summary": context["permission_summary"],
            "platform_identity_observed_at": timezone.now(),
        })
    device = DeviceRegistration.objects.select_for_update().filter(device_id=device_id).first()
    if device and device.user_id != actor.pk:
        raise GovernanceError("该设备已绑定其他实名用户", "DEVICE_OWNERSHIP_CONFLICT", 409)
    if device:
        for key, value in defaults.items(): setattr(device, key, value)
        device.save()
    else:
        device = DeviceRegistration.objects.create(device_id=device_id, **defaults)
    if existing_account_device:
        AuditEvent.objects.create(
            actor=actor,
            event_type="STALE_DEVICE_REGISTRATION_REPLACED",
            object_type="DEVICE_REGISTRATION",
            object_id=device.device_id,
            role_snapshot=active_roles(actor),
            enterprise_scope_snapshot=enterprise_scope_for_user(actor),
            detail={"platformAccountMatched": True, "staleSeconds": stale_seconds},
        )
    return device


@transaction.atomic
def verify_platform_action_context(*, actor, device_id, platform_display_name, route, request_id=""):
    require_permission(actor, "action.execute")
    if not active_shift_for_user(actor):
        raise GovernanceError("请先认领当前值班班次", "ACTIVE_SHIFT_REQUIRED", 409)
    device_id = str(device_id or "").strip()
    device = DeviceRegistration.objects.select_for_update().filter(
        device_id=device_id, user=actor, is_active=True,
    ).first()
    if not device:
        raise GovernanceError("当前动作设备尚未登记", "DEVICE_NOT_REGISTERED", 409)
    if device.last_seen_at < timezone.now() - timedelta(minutes=2):
        raise GovernanceError("当前动作设备心跳已过期", "DEVICE_HEARTBEAT_STALE", 409)
    expected_route = safe_platform_route(route)
    if expected_route != "#/vehicle-monitor/real-time" or device.last_route != expected_route:
        raise GovernanceError("省平台当前页面不是实时监控页", "PLATFORM_ROUTE_REQUIRED", 409)
    display_name = str(platform_display_name or "").strip()
    if not display_name or display_name != device.platform_display_name:
        raise GovernanceError("省平台显示身份与最近心跳不一致", "PLATFORM_IDENTITY_MISMATCH", 409)
    if device.session_status != "AUTHENTICATED":
        raise GovernanceError("省平台会话尚未确认登录", "PLATFORM_SESSION_REQUIRED", 409)
    device.platform_identity_status = "VERIFIED"
    device.platform_identity_observed_at = timezone.now()
    device.save(update_fields=["platform_identity_status", "platform_identity_observed_at", "updated_at"])
    AuditEvent.objects.create(
        actor=actor,
        event_type="PLATFORM_ACTION_CONTEXT_VERIFIED",
        object_type="DEVICE_REGISTRATION",
        object_id=device.device_id,
        role_snapshot=active_roles(actor),
        enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"route": expected_route, "displayNameMatched": True},
        request_id=request_id,
    )
    return device


@transaction.atomic
def record_keepalive_audit(*, actor, payload):
    require_permission(actor, "session.keepalive.execute")
    if not active_shift_for_user(actor):
        raise GovernanceError("请先认领当前值班班次", "ACTIVE_SHIFT_REQUIRED", 409)
    allowed_keys = {"deviceId", "policyVersion", "attemptedAt", "route", "resultCode", "latencyMs"}
    if set(payload) - allowed_keys:
        raise GovernanceError("保活审计包含未允许字段", "INVALID_KEEPALIVE_AUDIT", 422)
    device = DeviceRegistration.objects.filter(device_id=str(payload.get("deviceId") or ""), user=actor, is_active=True).first()
    if not device:
        raise GovernanceError("设备尚未登记", "DEVICE_NOT_REGISTERED", 409)
    result_code = str(payload.get("resultCode") or "")
    if result_code not in KEEPALIVE_RESULT_CODES:
        raise GovernanceError("保活结果码无效", "INVALID_KEEPALIVE_RESULT", 422)
    try:
        attempted_at = datetime.fromisoformat(str(payload.get("attemptedAt") or "").replace("Z", "+00:00"))
        policy_version = int(payload.get("policyVersion"))
        latency_ms = max(0, min(int(payload.get("latencyMs") or 0), 300000))
    except (TypeError, ValueError) as exc:
        raise GovernanceError("保活审计时间、版本或耗时无效", "INVALID_KEEPALIVE_AUDIT", 422) from exc
    if timezone.is_naive(attempted_at):
        attempted_at = timezone.make_aware(attempted_at, timezone.get_current_timezone())
    audit = SessionKeepaliveAudit.objects.create(
        actor=actor, device=device, policy_version=policy_version, route=safe_platform_route(payload.get("route")),
        result_code=result_code, latency_ms=latency_ms, attempted_at=attempted_at,
    )
    return audit


def active_roles(user):
    if not user.is_authenticated:
        return []
    if hasattr(user, "prefetched_active_roles"):
        return [assignment.role for assignment in user.prefetched_active_roles]
    return list(user.assistant_roles.filter(is_active=True).values_list("role", flat=True))


def permissions_for_roles(roles):
    permissions = set()
    for role in roles:
        permissions.update(ROLE_PERMISSIONS.get(role, set()))
    return sorted(permissions)


def require_permission(user, permission):
    roles = active_roles(user)
    if permission not in permissions_for_roles(roles):
        raise GovernanceError(f"当前实名角色缺少权限：{permission}", "PERMISSION_DENIED", 403)
    return roles


def visible_enterprise_scopes(user):
    if not user.is_authenticated:
        return []
    grants = getattr(user, "prefetched_enterprise_grants", None)
    if grants is None:
        grants = list(EnterpriseGrant.objects.filter(user=user, enterprise__is_active=True).select_related("enterprise"))
    else:
        grants = list(grants)
    if not grants:
        return []

    scopes = list(EnterpriseScope.objects.filter(is_active=True).select_related("parent").order_by("code"))
    children = {}
    for scope in scopes:
        children.setdefault(scope.parent_id, []).append(scope)

    visible = {}
    for grant in grants:
        stack = [grant.enterprise]
        while stack:
            scope = stack.pop()
            current = visible.get(scope.pk)
            inherited_sensitive = bool(grant.can_view_sensitive)
            if current is None or inherited_sensitive and not current[1]:
                visible[scope.pk] = (scope, inherited_sensitive, grant.enterprise.public_id)
            stack.extend(children.get(scope.pk, []))
    return [visible[key] for key in sorted(visible, key=lambda pk: visible[pk][0].code)]


def enterprise_scope_ids_for_user(user):
    return {scope.pk for scope, _sensitive, _inherited_from in visible_enterprise_scopes(user)}


def select_authorized_enterprise_scopes(user, public_ids):
    if not isinstance(public_ids, (list, tuple, set)) or not public_ids:
        raise GovernanceError("必须明确选择至少一个企业范围", "ENTERPRISE_SCOPE_REQUIRED", 422)
    requested = {str(value).strip() for value in public_ids if str(value).strip()}
    if not requested or len(requested) > 500:
        raise GovernanceError("企业范围数量无效", "INVALID_ENTERPRISE_SCOPE", 422)
    try:
        scopes = list(EnterpriseScope.objects.filter(public_id__in=requested, is_active=True))
    except (ValidationError, ValueError) as exc:
        raise GovernanceError("企业范围标识无效", "INVALID_ENTERPRISE_SCOPE", 422) from exc
    if len(scopes) != len(requested):
        raise GovernanceError("企业范围包含不存在或已停用的项目", "INVALID_ENTERPRISE_SCOPE", 422)
    allowed_ids = enterprise_scope_ids_for_user(user)
    if any(scope.pk not in allowed_ids for scope in scopes):
        raise GovernanceError("不能操作未授权企业范围", "ENTERPRISE_SCOPE_DENIED", 403)
    return scopes


def normalize_enterprise_value(value):
    return "".join(str(value or "").split()).casefold()


def resolve_enterprise_for_user(user, company_id, company_name):
    company_id = normalize_enterprise_value(company_id)
    company_name = normalize_enterprise_value(company_name)
    if not company_id and not company_name:
        raise GovernanceError("缺少可验证的企业标识", "ENTERPRISE_UNRESOLVED", 422)
    visible_scopes = visible_enterprise_scopes(user)
    for scope, _sensitive, _inherited_from in visible_scopes:
        if company_id and company_id in {normalize_enterprise_value(scope.code), normalize_enterprise_value(scope.public_id)}:
            return scope
        if company_name and company_name == normalize_enterprise_value(scope.name):
            return scope
    # A province-platform group can explicitly allow discovery of the
    # enterprise children it exposes. This preserves enterprise-level facts
    # and reports instead of putting every event into the parent group.
    roots = [
        scope for scope, _sensitive, _inherited_from in visible_scopes
        if scope.allow_platform_enterprise_discovery
        and scope.scope_type in {EnterpriseScope.ScopeType.GROUP, EnterpriseScope.ScopeType.BRANCH}
    ]
    if roots:
        root = sorted(roots, key=lambda item: (item.code, item.pk))[0]
        identity = company_id or hashlib.sha256(company_name.encode("utf-8")).hexdigest()[:24]
        code = f"PLATFORM-{identity}"[:100]
        name = str(company_name or f"省平台企业 {identity}").strip()[:200]
        scope, _created = EnterpriseScope.objects.get_or_create(
            code=code,
            defaults={
                "name": name,
                "scope_type": EnterpriseScope.ScopeType.ENTERPRISE,
                "parent": root,
                "is_active": True,
            },
        )
        if scope.parent_id != root.pk:
            raise GovernanceError("省平台企业标识与其他授权范围冲突", "ENTERPRISE_CONFLICT", 409)
        return scope
    raise GovernanceError("企业不在当前用户授权范围内", "ENTERPRISE_SCOPE_DENIED", 403)


def enterprise_scope_for_user(user):
    return [{
        "enterpriseId": str(scope.public_id),
        "enterpriseCode": scope.code,
        "enterpriseName": scope.name,
        "scopeType": scope.scope_type,
        "canViewSensitive": can_view_sensitive,
        "inheritedFromEnterpriseId": str(inherited_from),
    } for scope, can_view_sensitive, inherited_from in visible_enterprise_scopes(user)]


def validate_role_separation(existing_roles, next_role):
    roles = set(existing_roles) | {next_role}
    separated_roles = {
        RoleAssignment.Role.UNIT_USER,
        RoleAssignment.Role.MONITOR_OPERATOR,
        RoleAssignment.Role.RULE_CONFIGURER,
        RoleAssignment.Role.RULE_REVIEWER,
    }
    if len(roles.intersection(separated_roles)) > 1:
        raise GovernanceError("监控、规则配置和规则审核必须由不同人员承担", "ROLE_SEPARATION_VIOLATION", 409)


@transaction.atomic
def bootstrap_first_admin(*, username, display_name, employee_code, password):
    if AssistantProfile.objects.select_for_update().exists():
        raise GovernanceError("系统已经完成首次初始化", "SYSTEM_ALREADY_INITIALIZED", 409)
    username = str(username or "").strip()
    display_name = str(display_name or "").strip()
    employee_code = str(employee_code or "").strip()
    if not username or len(username) > 150 or not display_name or len(display_name) > 100 or not employee_code or len(employee_code) > 100:
        raise GovernanceError("用户名、姓名或工号格式无效", "INVALID_ASSISTANT_USER", 422)
    if not isinstance(password, str) or len(password) < 12:
        raise GovernanceError("密码至少需要12位", "WEAK_PASSWORD", 422)
    try:
        validate_password(password)
    except ValidationError as exc:
        raise GovernanceError("密码不符合安全要求：" + "；".join(exc.messages), "WEAK_PASSWORD", 422) from exc
    user_model = get_user_model()
    if user_model.objects.filter(username=username).exists():
        raise GovernanceError("用户名已经存在", "ASSISTANT_USER_EXISTS", 409)
    user = user_model.objects.create_user(username=username, password=password)
    AssistantProfile.objects.create(user=user, display_name=display_name, employee_code=employee_code)
    assign_role(user=user, role=RoleAssignment.Role.SYSTEM_ADMIN, assigned_by=user)
    return user


@transaction.atomic
def create_assistant_user(*, actor, username, display_name, employee_code, password, role):
    require_permission(actor, "identity.manage")
    username = str(username or "").strip()
    display_name = str(display_name or "").strip()
    employee_code = str(employee_code or "").strip()
    if not username or len(username) > 150 or not display_name or len(display_name) > 100 or not employee_code or len(employee_code) > 100:
        raise GovernanceError("用户名、姓名或工号格式无效", "INVALID_ASSISTANT_USER", 422)
    if role not in RoleAssignment.Role.values:
        raise GovernanceError("无效角色", "INVALID_ROLE", 422)
    user_model = get_user_model()
    if user_model.objects.filter(username=username).exists() or AssistantProfile.objects.filter(employee_code=employee_code).exists():
        raise GovernanceError("用户名或工号已经存在", "ASSISTANT_USER_EXISTS", 409)
    if not isinstance(password, str) or len(password) < 12:
        raise GovernanceError("密码至少需要12位", "WEAK_PASSWORD", 422)
    try:
        validate_password(password)
    except ValidationError as exc:
        raise GovernanceError("密码不符合安全要求：" + "；".join(exc.messages), "WEAK_PASSWORD", 422) from exc
    user = user_model.objects.create_user(username=username, password=password)
    AssistantProfile.objects.create(user=user, display_name=display_name, employee_code=employee_code)
    assign_role(user=user, role=role, assigned_by=actor)
    AuditEvent.objects.create(
        actor=actor, event_type="ASSISTANT_USER_CREATED", object_type="USER", object_id=str(user.pk),
        role_snapshot=active_roles(actor), enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"username": username, "employeeCode": employee_code, "initialRole": role},
    )
    return user


@transaction.atomic
def create_enterprise_scope(*, actor, code, name, scope_type, parent=None):
    require_permission(actor, "enterprise.manage")
    code = str(code or "").strip()
    name = str(name or "").strip()
    if not code or len(code) > 100 or not name or len(name) > 200:
        raise GovernanceError("企业编码或名称格式无效", "INVALID_ENTERPRISE", 422)
    if scope_type not in EnterpriseScope.ScopeType.values:
        raise GovernanceError("企业层级类型无效", "INVALID_ENTERPRISE_TYPE", 422)
    if EnterpriseScope.objects.filter(code=code).exists():
        raise GovernanceError("企业编码已经存在", "ENTERPRISE_EXISTS", 409)
    if scope_type == EnterpriseScope.ScopeType.GROUP and parent is not None:
        raise GovernanceError("集团不能设置上级范围", "INVALID_ENTERPRISE_PARENT", 422)
    if scope_type == EnterpriseScope.ScopeType.BRANCH and (parent is None or parent.scope_type != EnterpriseScope.ScopeType.GROUP):
        raise GovernanceError("分公司必须隶属于集团", "INVALID_ENTERPRISE_PARENT", 422)
    if scope_type == EnterpriseScope.ScopeType.ENTERPRISE and parent is not None and parent.scope_type not in {EnterpriseScope.ScopeType.GROUP, EnterpriseScope.ScopeType.BRANCH}:
        raise GovernanceError("企业上级必须是集团或分公司", "INVALID_ENTERPRISE_PARENT", 422)
    scope = EnterpriseScope.objects.create(code=code, name=name, scope_type=scope_type, parent=parent)
    AuditEvent.objects.create(
        actor=actor, event_type="ENTERPRISE_SCOPE_CREATED", object_type="ENTERPRISE_SCOPE", object_id=str(scope.public_id),
        role_snapshot=active_roles(actor), enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"code": code, "name": name, "scopeType": scope_type, "parentId": str(parent.public_id) if parent else None},
    )
    return scope


def active_shift_for_user(user):
    if not user.is_authenticated:
        return None
    if hasattr(user, "prefetched_active_shifts"):
        return user.prefetched_active_shifts[0] if user.prefetched_active_shifts else None
    return DutyShift.objects.filter(user=user, ended_at__isnull=True).first()


def shift_payload(shift):
    if not shift:
        return None
    return {
        "shiftId": str(shift.public_id),
        "platformAccountRef": shift.platform_account_ref,
        "workstationId": shift.workstation_id,
        "startedAt": shift.started_at.isoformat(),
    }


def identity_payload(user):
    profile = user.assistant_profile
    roles = active_roles(user)
    return {
        "userId": str(user.pk),
        "username": user.get_username(),
        "displayName": profile.display_name,
        "employeeCode": profile.employee_code,
        "roles": roles,
        "permissions": permissions_for_roles(roles),
        "enterpriseScopes": enterprise_scope_for_user(user),
        "activeShift": shift_payload(active_shift_for_user(user)),
    }


@transaction.atomic
def assign_role(*, user, role, assigned_by=None, request_id=""):
    profile = getattr(user, "assistant_profile", None)
    if not profile or not profile.is_active:
        raise GovernanceError("目标用户没有有效的实名助手档案", "ASSISTANT_PROFILE_REQUIRED", 409)
    if role not in RoleAssignment.Role.values:
        raise GovernanceError("无效角色", "INVALID_ROLE")
    validate_role_separation(active_roles(user), role)
    assignment, _ = RoleAssignment.objects.update_or_create(
        user=user,
        role=role,
        defaults={"assigned_by": assigned_by, "is_active": True},
    )
    AuditEvent.objects.create(
        actor=assigned_by,
        event_type="ROLE_ASSIGNED",
        object_type="USER",
        object_id=str(user.pk),
        role_snapshot=active_roles(user),
        enterprise_scope_snapshot=enterprise_scope_for_user(user),
        detail={"assignedRole": role},
        request_id=request_id,
    )
    return assignment


@transaction.atomic
def deactivate_role(*, user, role, actor, request_id=""):
    require_permission(actor, "identity.manage")
    assignment = RoleAssignment.objects.filter(user=user, role=role, is_active=True).first()
    if not assignment:
        raise GovernanceError("目标用户没有该活动角色", "ROLE_NOT_FOUND", 404)
    assignment.is_active = False
    assignment.assigned_by = actor
    assignment.save(update_fields=["is_active", "assigned_by", "updated_at"])
    AuditEvent.objects.create(
        actor=actor,
        event_type="ROLE_DEACTIVATED",
        object_type="USER",
        object_id=str(user.pk),
        role_snapshot=active_roles(user),
        enterprise_scope_snapshot=enterprise_scope_for_user(user),
        detail={"deactivatedRole": role},
        request_id=request_id,
    )
    return assignment


@transaction.atomic
def grant_enterprise(*, user, enterprise, actor, can_view_sensitive=False, request_id=""):
    require_permission(actor, "identity.manage")
    grant, _ = EnterpriseGrant.objects.update_or_create(
        user=user,
        enterprise=enterprise,
        defaults={"can_view_sensitive": bool(can_view_sensitive)},
    )
    AuditEvent.objects.create(
        actor=actor,
        event_type="ENTERPRISE_SCOPE_GRANTED",
        object_type="USER",
        object_id=str(user.pk),
        role_snapshot=active_roles(user),
        enterprise_scope_snapshot=enterprise_scope_for_user(user),
        detail={"enterpriseId": str(enterprise.public_id), "canViewSensitive": grant.can_view_sensitive},
        request_id=request_id,
    )
    return grant


@transaction.atomic
def update_platform_enterprise_discovery(*, actor, enterprise, enabled, request_id=""):
    """Allow an administrator to opt a GROUP/BRANCH into platform discovery."""
    require_permission(actor, "enterprise.manage")
    if enterprise.scope_type not in {EnterpriseScope.ScopeType.GROUP, EnterpriseScope.ScopeType.BRANCH}:
        raise GovernanceError("只有集团或分公司范围可以作为省平台企业发现根", "INVALID_DISCOVERY_ROOT", 422)
    enterprise.allow_platform_enterprise_discovery = bool(enabled)
    enterprise.save(update_fields=["allow_platform_enterprise_discovery", "updated_at"])
    AuditEvent.objects.create(
        actor=actor,
        event_type="PLATFORM_ENTERPRISE_DISCOVERY_UPDATED",
        object_type="ENTERPRISE_SCOPE",
        object_id=str(enterprise.public_id),
        role_snapshot=active_roles(actor),
        enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"enabled": enterprise.allow_platform_enterprise_discovery},
        request_id=request_id,
    )
    return enterprise


@transaction.atomic
def claim_shift(*, user, platform_account_ref, workstation_id, request_id=""):
    profile = getattr(user, "assistant_profile", None)
    if not profile or not profile.is_active:
        raise GovernanceError("当前账号没有有效的实名助手档案", "ASSISTANT_PROFILE_REQUIRED", 403)
    roles = active_roles(user)
    if not roles or not set(roles).intersection({RoleAssignment.Role.UNIT_USER, RoleAssignment.Role.MONITOR_OPERATOR}):
        raise GovernanceError("只有采集员或监控操作员可以认领班次", "SHIFT_ROLE_REQUIRED", 403)
    platform_account_ref = str(platform_account_ref or "").strip()
    workstation_id = str(workstation_id or "").strip()
    if not platform_account_ref or len(platform_account_ref) > 120:
        raise GovernanceError("省平台账号标识不能为空且不能超过120字符", "INVALID_PLATFORM_ACCOUNT")
    if not workstation_id or len(workstation_id) > 120:
        raise GovernanceError("工作站标识不能为空且不能超过120字符", "INVALID_WORKSTATION")
    existing = DutyShift.objects.select_for_update().filter(user=user, ended_at__isnull=True).first()
    if existing:
        if existing.platform_account_ref == platform_account_ref and existing.workstation_id == workstation_id:
            return existing
        raise GovernanceError("当前用户已有活动班次，请先结束后再重新认领", "ACTIVE_SHIFT_EXISTS", 409)
    occupied = DutyShift.objects.select_for_update().filter(workstation_id=workstation_id, ended_at__isnull=True).first()
    if occupied:
        raise GovernanceError("该工作站已被其他实名用户认领", "WORKSTATION_OCCUPIED", 409)
    platform_occupied = DutyShift.objects.select_for_update().filter(platform_account_ref=platform_account_ref, ended_at__isnull=True).first()
    if platform_occupied:
        raise GovernanceError("该省平台账号标识已被其他实名用户认领", "PLATFORM_ACCOUNT_OCCUPIED", 409)
    shift = DutyShift.objects.create(
        user=user,
        platform_account_ref=platform_account_ref,
        workstation_id=workstation_id,
        role_snapshot=roles,
        enterprise_scope_snapshot=enterprise_scope_for_user(user),
    )
    AuditEvent.objects.create(
        actor=user,
        event_type="SHIFT_CLAIMED",
        object_type="DUTY_SHIFT",
        object_id=str(shift.public_id),
        role_snapshot=shift.role_snapshot,
        enterprise_scope_snapshot=shift.enterprise_scope_snapshot,
        detail={"platformAccountRef": platform_account_ref, "workstationId": workstation_id},
        request_id=request_id,
    )
    return shift


@transaction.atomic
def release_shift(*, user, request_id=""):
    shift = DutyShift.objects.select_for_update().filter(user=user, ended_at__isnull=True).first()
    if not shift:
        raise GovernanceError("当前没有活动班次", "ACTIVE_SHIFT_NOT_FOUND", 404)
    shift.ended_at = timezone.now()
    shift.save(update_fields=["ended_at", "updated_at"])
    AuditEvent.objects.create(
        actor=user,
        event_type="SHIFT_RELEASED",
        object_type="DUTY_SHIFT",
        object_id=str(shift.public_id),
        role_snapshot=shift.role_snapshot,
        enterprise_scope_snapshot=shift.enterprise_scope_snapshot,
        detail={"platformAccountRef": shift.platform_account_ref, "workstationId": shift.workstation_id},
        request_id=request_id,
    )
    return shift
