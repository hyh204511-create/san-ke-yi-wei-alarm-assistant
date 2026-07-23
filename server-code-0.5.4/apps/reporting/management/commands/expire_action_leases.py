from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.reporting.models import ActionLease
from apps.reporting.services import expire_stale_action_leases


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
        changed = expire_stale_action_leases(now=now)
        self.stdout.write(f"已将 {changed} 个超时动作租约标记为UNKNOWN并生成通知")
