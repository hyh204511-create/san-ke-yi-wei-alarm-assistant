from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.reporting.models import ActionLease
from apps.reporting.services import ensure_action_notification


class Command(BaseCommand):
    help = "将超时未回执的动作租约标记为UNKNOWN并通知对应值班人员"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="只统计，不写入")

    def handle(self, *args, **options):
        now = timezone.now()
        queryset = ActionLease.objects.filter(
            status__in=[ActionLease.Status.ACTIVE, ActionLease.Status.EXECUTING],
            expires_at__lte=now,
        ).select_related("fact__enterprise", "actor")
        count = queryset.count()
        if options["dry_run"]:
            self.stdout.write(f"将标记 {count} 个超时动作租约")
            return
        changed = 0
        for lease in queryset:
            with transaction.atomic():
                locked = ActionLease.objects.select_for_update().select_related("fact__enterprise", "actor").get(pk=lease.pk)
                if locked.status not in {ActionLease.Status.ACTIVE, ActionLease.Status.EXECUTING} or locked.expires_at > now:
                    continue
                locked.status = ActionLease.Status.UNKNOWN
                locked.result_code = "UNKNOWN"
                locked.result_payload = {"timeout": True, "expiredAt": now.isoformat()}
                locked.finished_at = now
                locked.last_attempt_at = now
                locked.save(update_fields=["status", "result_code", "result_payload", "finished_at", "last_attempt_at", "updated_at"])
                ensure_action_notification(
                    actor=locked.actor, fact=locked.fact, result_code="UNKNOWN",
                    action_type=locked.action_type, lease=locked,
                    detail={"timeout": True, "expiredAt": now.isoformat()},
                )
                changed += 1
        self.stdout.write(f"已将 {changed} 个超时动作租约标记为UNKNOWN并生成通知")
