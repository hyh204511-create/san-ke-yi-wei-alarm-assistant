from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.governance.models import AuditEvent, SessionKeepaliveAudit

from ...models import ActionLease, AlarmFact, CaptureSource
from apps.disposals.models import DisposalCase


class Command(BaseCommand):
    help = "按DATA_RETENTION_DAYS清理可安全删除的运行数据；默认保留365天"

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=None, help="覆盖默认保留天数，仅用于受控运维")
        parser.add_argument("--dry-run", action="store_true", help="只统计，不删除")

    def handle(self, *args, **options):
        days = int(options["days"] or settings.DATA_RETENTION_DAYS)
        if days < 365:
            self.stderr.write(self.style.ERROR("运行数据保留期不能少于365天"))
            return 2
        cutoff = timezone.now() - timedelta(days=days)
        old_captures = CaptureSource.objects.filter(captured_at__lt=cutoff)
        old_keepalives = SessionKeepaliveAudit.objects.filter(attempted_at__lt=cutoff)
        old_audits = AuditEvent.objects.filter(created_at__lt=cutoff)
        old_facts = AlarmFact.objects.filter(last_seen_at__lt=cutoff)
        protected_event_ids = set(DisposalCase.objects.filter(event_id__in=old_facts.values("event_id")).values_list("event_id", flat=True))
        protected_fact_ids = set(ActionLease.objects.filter(fact_id__in=old_facts.values("id")).values_list("fact_id", flat=True))
        deletable_facts = old_facts.exclude(event_id__in=protected_event_ids).exclude(pk__in=protected_fact_ids)
        counts = {
            "captures": old_captures.count(),
            "keepaliveAudits": old_keepalives.count(),
            "auditEvents": old_audits.count(),
            "alarmFacts": deletable_facts.count(),
            "protectedAlarmFacts": old_facts.count() - deletable_facts.count(),
        }
        if options["dry_run"]:
            self.stdout.write(self.style.WARNING(f"dry-run cutoff={cutoff.isoformat()} counts={counts}"))
            return
        with transaction.atomic():
            old_captures.delete()
            old_keepalives.delete()
            old_audits.delete()
            deletable_facts.delete()
        self.stdout.write(self.style.SUCCESS(f"已清理保留期前运行数据 cutoff={cutoff.isoformat()} counts={counts}"))
