from django.db import transaction
from django.utils import timezone

from apps.governance.models import AuditEvent
from apps.governance.services import (
    GovernanceError,
    active_shift_for_user,
    enterprise_scope_for_user,
    enterprise_scope_ids_for_user,
    require_permission,
    resolve_enterprise_for_user,
)

from .models import DisposalCase, DisposalEvent


class DisposalError(Exception):
    def __init__(self, message, code="DISPOSAL_ERROR", status=400):
        super().__init__(message)
        self.code = code
        self.status = status


def require_disposal_permission(actor, permission, *, require_shift=True):
    try:
        require_permission(actor, permission)
    except GovernanceError as exc:
        raise DisposalError(str(exc), exc.code, exc.status) from exc
    if require_shift and not active_shift_for_user(actor):
        raise DisposalError("请先认领当前值班班次", "ACTIVE_SHIFT_REQUIRED", 409)


def resolve_event_enterprise(actor, event):
    try:
        return resolve_enterprise_for_user(actor, event.get("companyId"), event.get("companyName"))
    except GovernanceError as exc:
        raise DisposalError(str(exc), exc.code, exc.status) from exc


def require_case_access(actor, case):
    if case.enterprise_id not in enterprise_scope_ids_for_user(actor):
        raise DisposalError("无权访问该企业的处置工单", "ENTERPRISE_SCOPE_DENIED", 403)


def check_expected_version(case, expected_version):
    if expected_version is None:
        return
    try:
        expected = int(expected_version)
    except (TypeError, ValueError) as exc:
        raise DisposalError("工单版本无效", "INVALID_CASE_VERSION", 422) from exc
    if expected != case.version:
        raise DisposalError("工单已被其他人员更新，请刷新后重试", "STALE_CASE_VERSION", 409)


def record_event(case, action, actor, *, previous_status=None, comment="", detail=None):
    DisposalEvent.objects.create(
        disposal_case=case,
        action=action,
        actor=actor,
        from_status=previous_status or case.status,
        to_status=case.status,
        comment=str(comment or "")[:1000],
        detail=detail or {},
    )
    AuditEvent.objects.create(
        actor=actor,
        event_type=f"DISPOSAL_{action}",
        object_type="DISPOSAL_CASE",
        object_id=str(case.public_id),
        role_snapshot=list(actor.assistant_roles.filter(is_active=True).values_list("role", flat=True)),
        enterprise_scope_snapshot=enterprise_scope_for_user(actor),
        detail={"eventId": case.event_id, "enterpriseId": str(case.enterprise.public_id), "status": case.status, **(detail or {})},
    )


def locked_case(case):
    return DisposalCase.objects.select_for_update().select_related(
        "enterprise", "assigned_to__assistant_profile", "completed_by__assistant_profile", "reviewed_by__assistant_profile"
    ).get(pk=case.pk)


@transaction.atomic
def upsert_manual_case(*, actor, event, decision):
    require_disposal_permission(actor, "alarm.view")
    if not isinstance(event, dict) or not isinstance(decision, dict):
        raise DisposalError("报警和规则判断必须是JSON对象", "INVALID_PAYLOAD", 422)
    event_id = str(event.get("eventId") or "").strip()
    if not event_id or len(event_id) > 160:
        raise DisposalError("报警事件标识无效", "INVALID_EVENT_ID", 422)
    if event.get("sourceKind") in {"PREWARNING", "DETAIL"}:
        raise DisposalError("预警和历史详情不创建实时处置工单", "SOURCE_NOT_ACTIONABLE", 409)
    if decision.get("action") != "MANUAL_REVIEW":
        raise DisposalError("只有转人工判断可以创建处置工单", "MANUAL_DECISION_REQUIRED", 409)
    enterprise = resolve_event_enterprise(actor, event)
    case = DisposalCase.objects.select_for_update().filter(event_id=event_id).first()
    if case:
        require_case_access(actor, case)
        if case.enterprise_id != enterprise.pk:
            raise DisposalError("同一报警的企业归属发生冲突", "ENTERPRISE_CONFLICT", 409)
        if case.latest_event_snapshot == event and case.decision_snapshot == decision:
            return case, False
        case.latest_event_snapshot = event
        case.decision_snapshot = decision
        case.version += 1
        case.save(update_fields=["latest_event_snapshot", "decision_snapshot", "version", "updated_at"])
        record_event(case, DisposalEvent.Action.SNAPSHOT_UPDATED, actor)
        return case, False
    requires_review = bool(event.get("sourceKind") in {"REALTIME", "TECHNICAL"} or decision.get("permissionBlockers"))
    case = DisposalCase.objects.create(
        event_id=event_id,
        alarm_id=str(event.get("alarmId") or "")[:160],
        enterprise=enterprise,
        source_kind=str(event.get("sourceKind") or "OTHER")[:30],
        alarm_name=str(event.get("alarmName") or "")[:200],
        vehicle_no=str(event.get("vehicleNo") or "")[:100],
        event_snapshot=event,
        latest_event_snapshot=event,
        decision_snapshot=decision,
        requires_review=requires_review,
    )
    record_event(case, DisposalEvent.Action.CREATED, actor, detail={"requiresReview": requires_review})
    return case, True


@transaction.atomic
def takeover_case(*, actor, case, expected_version=None):
    require_disposal_permission(actor, "disposal.takeover")
    case = locked_case(case)
    require_case_access(actor, case)
    check_expected_version(case, expected_version)
    if case.status not in {DisposalCase.Status.MANUAL_REQUIRED, DisposalCase.Status.REOPENED, DisposalCase.Status.IN_MANUAL}:
        raise DisposalError("当前工单状态不能接管", "INVALID_DISPOSAL_STATUS", 409)
    if case.assigned_to_id and case.assigned_to_id != actor.pk:
        raise DisposalError("工单已被其他人员接管", "CASE_ALREADY_ASSIGNED", 409)
    previous = case.status
    case.status = DisposalCase.Status.IN_MANUAL
    case.assigned_to = actor
    case.taken_over_at = case.taken_over_at or timezone.now()
    case.version += 1
    case.save(update_fields=["status", "assigned_to", "taken_over_at", "version", "updated_at"])
    record_event(case, DisposalEvent.Action.TAKEN_OVER, actor, previous_status=previous)
    return case


@transaction.atomic
def add_note(*, actor, case, comment, expected_version=None):
    require_disposal_permission(actor, "disposal.note")
    case = locked_case(case)
    require_case_access(actor, case)
    check_expected_version(case, expected_version)
    comment = str(comment or "").strip()
    if not comment or len(comment) > 1000:
        raise DisposalError("处置备注必须为1至1000字符", "INVALID_DISPOSAL_NOTE", 422)
    if case.assigned_to_id not in {None, actor.pk}:
        raise DisposalError("只能由当前接管人添加处置备注", "CASE_ASSIGNEE_REQUIRED", 403)
    case.version += 1
    case.save(update_fields=["version", "updated_at"])
    record_event(case, DisposalEvent.Action.NOTE_ADDED, actor, comment=comment)
    return case


@transaction.atomic
def complete_case(*, actor, case, resolution_code, resolution_note, expected_version=None):
    require_disposal_permission(actor, "disposal.complete")
    case = locked_case(case)
    require_case_access(actor, case)
    check_expected_version(case, expected_version)
    if case.status != DisposalCase.Status.IN_MANUAL or case.assigned_to_id != actor.pk:
        raise DisposalError("只有当前接管人可以提交处置结果", "CASE_ASSIGNEE_REQUIRED", 403)
    resolution_code = str(resolution_code or "").strip()
    resolution_note = str(resolution_note or "").strip()
    if not resolution_code or len(resolution_code) > 80 or not resolution_note or len(resolution_note) > 1000:
        raise DisposalError("处置结果代码和说明不能为空", "INVALID_RESOLUTION", 422)
    previous = case.status
    case.completed_by = actor
    case.completed_at = timezone.now()
    case.resolution_code = resolution_code
    case.resolution_note = resolution_note
    case.status = DisposalCase.Status.PENDING_REVIEW if case.requires_review else DisposalCase.Status.COMPLETED
    case.version += 1
    case.save(update_fields=["completed_by", "completed_at", "resolution_code", "resolution_note", "status", "version", "updated_at"])
    action = DisposalEvent.Action.SUBMITTED_REVIEW if case.requires_review else DisposalEvent.Action.COMPLETED
    record_event(case, action, actor, previous_status=previous, comment=resolution_note, detail={"resolutionCode": resolution_code})
    return case


@transaction.atomic
def review_case(*, actor, case, approved, comment, expected_version=None):
    require_disposal_permission(actor, "disposal.review", require_shift=False)
    case = locked_case(case)
    require_case_access(actor, case)
    check_expected_version(case, expected_version)
    if case.status != DisposalCase.Status.PENDING_REVIEW:
        raise DisposalError("当前工单不在待复核状态", "INVALID_DISPOSAL_STATUS", 409)
    if actor.pk in {case.assigned_to_id, case.completed_by_id}:
        raise DisposalError("处置执行人不能复核本人结果", "DISPOSAL_REVIEW_SEPARATION", 409)
    comment = str(comment or "").strip()
    if not comment or len(comment) > 1000:
        raise DisposalError("复核意见必须为1至1000字符", "INVALID_REVIEW_COMMENT", 422)
    previous = case.status
    case.reviewed_by = actor
    case.reviewed_at = timezone.now()
    case.review_comment = comment
    case.status = DisposalCase.Status.COMPLETED if approved else DisposalCase.Status.IN_MANUAL
    if not approved:
        case.completed_at = None
    case.version += 1
    case.save(update_fields=["reviewed_by", "reviewed_at", "review_comment", "status", "completed_at", "version", "updated_at"])
    action = DisposalEvent.Action.REVIEW_APPROVED if approved else DisposalEvent.Action.REVIEW_REJECTED
    record_event(case, action, actor, previous_status=previous, comment=comment)
    return case


@transaction.atomic
def reopen_case(*, actor, case, comment, expected_version=None):
    require_disposal_permission(actor, "disposal.reopen", require_shift=False)
    case = locked_case(case)
    require_case_access(actor, case)
    check_expected_version(case, expected_version)
    if case.status != DisposalCase.Status.COMPLETED:
        raise DisposalError("只有已完成工单可以重开", "INVALID_DISPOSAL_STATUS", 409)
    comment = str(comment or "").strip()
    if not comment or len(comment) > 1000:
        raise DisposalError("重开原因必须为1至1000字符", "INVALID_REOPEN_COMMENT", 422)
    previous = case.status
    case.status = DisposalCase.Status.REOPENED
    case.assigned_to = None
    case.taken_over_at = None
    case.version += 1
    case.save(update_fields=["status", "assigned_to", "taken_over_at", "version", "updated_at"])
    record_event(case, DisposalEvent.Action.REOPENED, actor, previous_status=previous, comment=comment)
    return case
