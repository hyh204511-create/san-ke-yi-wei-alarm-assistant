import base64
import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from datetime import timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import transaction
from django.utils import timezone

from apps.disposals.models import DisposalCase
from apps.governance.encrypted_fields import sensitive_data_key
from apps.governance.models import AuditEvent, EnterpriseScope
from apps.governance.services import GovernanceError, enterprise_scope_for_user, enterprise_scope_ids_for_user, require_permission
from apps.reporting.models import AlarmFact

from .models import EvidenceRequest


ALLOWED_FIELDS = {"EVENT", "FIELD_SOURCES", "DECISION", "ACTION", "DISPOSAL"}
FORBIDDEN_KEY = re.compile(r"authorization|cookie|credential|password|secret|session|token|mobile|phone|idcard", re.I)
MAX_PACKAGE_BYTES = 50 * 1024 * 1024


class EvidenceError(Exception):
    def __init__(self, message, code="EVIDENCE_ERROR", status=400):
        super().__init__(message)
        self.code = code
        self.status = status


def require_evidence_permission(actor, permission):
    try: require_permission(actor, permission)
    except GovernanceError as exc: raise EvidenceError(str(exc), exc.code, exc.status) from exc


def require_scope(actor, enterprise):
    if enterprise.pk not in enterprise_scope_ids_for_user(actor):
        raise EvidenceError("无权访问该企业证据", "ENTERPRISE_SCOPE_DENIED", 403)


def evidence_key():
    encoded = os.environ.get("EVIDENCE_MASTER_KEY", "").strip()
    if encoded:
        try: key = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        except ValueError as exc: raise ImproperlyConfigured("EVIDENCE_MASTER_KEY must be URL-safe base64") from exc
        if len(key) != 32: raise ImproperlyConfigured("EVIDENCE_MASTER_KEY must decode to exactly 32 bytes")
        return key
    if settings.ALLOW_DERIVED_DATA_KEYS:
        return hashlib.sha256(sensitive_data_key() + b":evidence-package").digest()
    raise ImproperlyConfigured("EVIDENCE_MASTER_KEY is required when derived data keys are disabled")


def sanitize(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if FORBIDDEN_KEY.search(str(key)) else sanitize(item) for key, item in value.items()}
    if isinstance(value, list): return [sanitize(item) for item in value]
    return value


def audit(actor, event_type, request, detail=None):
    AuditEvent.objects.create(
        actor=actor, event_type=event_type, object_type="EVIDENCE_REQUEST", object_id=str(request.public_id),
        role_snapshot=list(actor.assistant_roles.filter(is_active=True).values_list("role", flat=True)) if actor else [],
        enterprise_scope_snapshot=enterprise_scope_for_user(actor) if actor else [],
        detail={"enterpriseId": str(request.enterprise.public_id), "status": request.status, "fileHash": request.file_sha256 or None, **(detail or {})},
    )


@transaction.atomic
def create_request(*, actor, enterprise, event_ids, purpose, requested_fields):
    require_evidence_permission(actor, "evidence.request")
    require_scope(actor, enterprise)
    event_ids = list(dict.fromkeys(str(value).strip() for value in (event_ids or []) if str(value).strip()))
    if not event_ids or len(event_ids) > 100:
        raise EvidenceError("证据包必须选择1至100个报警事件", "INVALID_EVIDENCE_EVENTS", 422)
    found = set(AlarmFact.objects.filter(enterprise=enterprise, event_id__in=event_ids).values_list("event_id", flat=True))
    if found != set(event_ids):
        raise EvidenceError("证据事件不存在或超出企业范围", "EVIDENCE_EVENT_NOT_FOUND", 404)
    purpose = str(purpose or "").strip()
    if not purpose or len(purpose) > 500:
        raise EvidenceError("证据用途不能为空且不能超过500字符", "INVALID_EVIDENCE_PURPOSE", 422)
    fields = list(dict.fromkeys(str(value).upper() for value in (requested_fields or [])))
    if not fields or any(field not in ALLOWED_FIELDS for field in fields):
        raise EvidenceError("证据字段范围无效", "INVALID_EVIDENCE_FIELDS", 422)
    request = EvidenceRequest.objects.create(enterprise=enterprise, requested_by=actor, purpose=purpose, event_ids=event_ids, requested_fields=fields)
    audit(actor, "EVIDENCE_REQUESTED", request, {"eventCount": len(event_ids), "requestedFields": fields, "purpose": purpose})
    return request


def package_payload(request):
    facts = {fact.event_id: fact for fact in AlarmFact.objects.filter(enterprise=request.enterprise, event_id__in=request.event_ids)}
    missing = [event_id for event_id in request.event_ids if event_id not in facts]
    if missing:
        raise EvidenceError("证据源事件已不存在或已移出企业范围", "EVIDENCE_SOURCE_CHANGED", 409)
    cases = {case.event_id: case for case in DisposalCase.objects.filter(enterprise=request.enterprise, event_id__in=request.event_ids).prefetch_related("events")}
    records = []
    fields = set(request.requested_fields)
    for event_id in request.event_ids:
        fact = facts[event_id]
        event_snapshot = fact.event_snapshot if isinstance(fact.event_snapshot, dict) else {}
        record = {"eventId": event_id, "alarmId": fact.alarm_id, "enterprise": {"id": str(request.enterprise.public_id), "code": request.enterprise.code, "name": request.enterprise.name}}
        if "EVENT" in fields:
            event = sanitize(event_snapshot)
            if "FIELD_SOURCES" not in fields and isinstance(event, dict):
                event.pop("sources", None); event.pop("sourceCaptures", None); event.pop("conflicts", None)
            record["event"] = event
        if "FIELD_SOURCES" in fields:
            record["fieldSources"] = sanitize({"sources": event_snapshot.get("sources", {}), "conflicts": event_snapshot.get("conflicts", {})})
        if "DECISION" in fields: record["decision"] = sanitize(fact.decision_snapshot)
        if "ACTION" in fields: record["action"] = sanitize(fact.action_snapshot)
        if "DISPOSAL" in fields and event_id in cases:
            case = cases[event_id]
            record["disposal"] = sanitize({
                "status": case.status, "resolutionCode": case.resolution_code, "resolutionNote": case.resolution_note,
                "events": [{"action": item.action, "fromStatus": item.from_status, "toStatus": item.to_status, "comment": item.comment, "detail": item.detail, "createdAt": item.created_at.isoformat()} for item in case.events.all()],
            })
        records.append(record)
    return {
        "schemaVersion": 1, "classification": "L4_HIGH_SENSITIVITY_EVIDENCE", "requestId": str(request.public_id),
        "purpose": request.purpose, "requestedBy": str(request.requested_by_id), "approvedBy": str(request.reviewed_by_id),
        "enterprise": {"id": str(request.enterprise.public_id), "code": request.enterprise.code, "name": request.enterprise.name},
        "fieldManifest": request.requested_fields, "generatedAt": timezone.now().isoformat(), "records": records,
        "forbiddenDataPolicy": "Passwords, cookies, authorization headers, session identifiers and tokens are redacted.",
    }


def encrypt_package(request, payload):
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_PACKAGE_BYTES:
        raise EvidenceError("证据包超过 50MB 限制，请缩小事件或字段范围", "EVIDENCE_PACKAGE_TOO_LARGE", 413)
    nonce = os.urandom(12)
    aad = f"evidence:{request.public_id}".encode("ascii")
    ciphertext = AESGCM(evidence_key()).encrypt(nonce, raw, aad)
    return b"HNEVID1" + nonce + ciphertext


def decrypt_package(request, content):
    if not content.startswith(b"HNEVID1"):
        raise EvidenceError("证据包格式无效", "INVALID_EVIDENCE_PACKAGE", 422)
    aad = f"evidence:{request.public_id}".encode("ascii")
    raw = AESGCM(evidence_key()).decrypt(content[7:19], content[19:], aad)
    return json.loads(raw.decode("utf-8"))


@transaction.atomic
def review_request(*, actor, request, approved, comment):
    require_evidence_permission(actor, "evidence.review")
    request = EvidenceRequest.objects.select_for_update().select_related("enterprise", "requested_by").get(pk=request.pk)
    require_scope(actor, request.enterprise)
    if request.status != EvidenceRequest.Status.PENDING:
        raise EvidenceError("证据申请当前不在待审批状态", "INVALID_EVIDENCE_STATUS", 409)
    if request.requested_by_id == actor.pk:
        raise EvidenceError("证据包申请人不能审批本人申请", "EVIDENCE_REVIEW_SEPARATION", 409)
    comment = str(comment or "").strip()
    if not comment or len(comment) > 1000:
        raise EvidenceError("审批意见不能为空且不能超过1000字符", "INVALID_REVIEW_COMMENT", 422)
    request.reviewed_by = actor
    request.reviewed_at = timezone.now()
    request.review_comment = comment
    if not approved:
        request.status = EvidenceRequest.Status.REJECTED
        request.save(update_fields=["reviewed_by", "reviewed_at", "review_comment", "status", "updated_at"])
        audit(actor, "EVIDENCE_REJECTED", request, {"comment": comment})
        return request
    content = encrypt_package(request, package_payload(request))
    evidence_dir = Path(settings.EVIDENCE_EXPORT_DIR).resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    file_name = f"evidence-{request.enterprise.code}-{request.public_id}.evidence"
    path = (evidence_dir / f"{uuid.uuid4().hex}-{file_name}").resolve()
    if evidence_dir not in path.parents:
        raise EvidenceError("证据包路径无效", "INVALID_EVIDENCE_PATH", 500)
    path.write_bytes(content)
    request.status = EvidenceRequest.Status.READY
    request.file_name = file_name
    request.file_path = str(path)
    request.file_sha256 = hashlib.sha256(content).hexdigest()
    request.file_size = len(content)
    request.encryption_algorithm = "AES-256-GCM"
    request.expires_at = timezone.now() + timedelta(days=3)
    request.save(update_fields=["reviewed_by", "reviewed_at", "review_comment", "status", "file_name", "file_path", "file_sha256", "file_size", "encryption_algorithm", "expires_at", "updated_at"])
    audit(actor, "EVIDENCE_APPROVED", request, {"comment": comment, "eventCount": len(request.event_ids)})
    return request


@transaction.atomic
def record_download(*, actor, request):
    require_evidence_permission(actor, "evidence.download")
    request = EvidenceRequest.objects.select_for_update().select_related("enterprise").get(pk=request.pk)
    require_scope(actor, request.enterprise)
    if request.status != EvidenceRequest.Status.READY or not request.reviewed_by_id or request.expires_at <= timezone.now():
        raise EvidenceError("证据包已过期或不可下载", "EVIDENCE_NOT_AVAILABLE", 410)
    path = Path(request.file_path).resolve()
    evidence_dir = Path(settings.EVIDENCE_EXPORT_DIR).resolve()
    if evidence_dir not in path.parents or not path.is_file():
        raise EvidenceError("证据包文件不存在", "EVIDENCE_FILE_MISSING", 404)
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != request.file_sha256:
        raise EvidenceError("证据包完整性校验失败", "EVIDENCE_HASH_MISMATCH", 409)
    request.download_count += 1
    request.last_downloaded_at = timezone.now()
    request.save(update_fields=["download_count", "last_downloaded_at", "updated_at"])
    audit(actor, "EVIDENCE_DOWNLOADED", request, {"downloadCount": request.download_count})
    return request, content
