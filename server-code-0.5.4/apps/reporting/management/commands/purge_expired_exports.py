from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.governance.models import AuditEvent
from apps.reporting.models import ExportJob


class Command(BaseCommand):
    help = "删除已到期报表导出文件并保留删除审计"

    def handle(self, *args, **options):
        export_dir = Path(settings.REPORT_EXPORT_DIR).resolve()
        deleted = 0
        with transaction.atomic():
            jobs = list(ExportJob.objects.select_for_update().filter(status=ExportJob.Status.READY, expires_at__lte=timezone.now()))
            for job in jobs:
                path = Path(job.file_path).resolve()
                if export_dir in path.parents and path.is_file():
                    path.unlink()
                job.status = ExportJob.Status.DELETED
                job.save(update_fields=["status", "updated_at"])
                AuditEvent.objects.create(
                    actor=None, event_type="REPORT_EXPORT_DELETED", object_type="EXPORT_JOB", object_id=str(job.public_id),
                    detail={"fileHash": job.file_sha256, "expiredAt": job.expires_at.isoformat()},
                )
                deleted += 1
        self.stdout.write(self.style.SUCCESS(f"Deleted {deleted} expired report export(s)"))
