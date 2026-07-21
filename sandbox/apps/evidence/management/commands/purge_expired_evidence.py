from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.evidence.models import EvidenceRequest
from apps.governance.models import AuditEvent


class Command(BaseCommand):
    help = "删除到期敏感证据包并保留删除审计"

    def handle(self, *args, **options):
        evidence_dir = Path(settings.EVIDENCE_EXPORT_DIR).resolve()
        deleted = 0
        with transaction.atomic():
            items = list(EvidenceRequest.objects.select_for_update().filter(status=EvidenceRequest.Status.READY, expires_at__lte=timezone.now()))
            for item in items:
                path = Path(item.file_path).resolve()
                if evidence_dir in path.parents and path.is_file(): path.unlink()
                item.status = EvidenceRequest.Status.DELETED
                item.save(update_fields=["status", "updated_at"])
                AuditEvent.objects.create(actor=None, event_type="EVIDENCE_DELETED", object_type="EVIDENCE_REQUEST", object_id=str(item.public_id), detail={"fileHash": item.file_sha256, "expiredAt": item.expires_at.isoformat()})
                deleted += 1
        self.stdout.write(self.style.SUCCESS(f"Deleted {deleted} expired evidence package(s)"))

