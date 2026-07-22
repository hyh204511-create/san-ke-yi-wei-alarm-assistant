# Generated for plan-level global action locking.

from django.db import migrations, models
from django.db.models import Count
from django.utils import timezone


def close_duplicate_active_leases(apps, schema_editor):
    ActionLease = apps.get_model("reporting", "ActionLease")
    duplicates = (
        ActionLease.objects.filter(status__in=["ACTIVE", "EXECUTING"])
        .values("fact_id")
        .annotate(active_count=Count("id"))
        .filter(active_count__gt=1)
    )
    now = timezone.now()
    for row in duplicates.iterator():
        active = list(
            ActionLease.objects.filter(
                fact_id=row["fact_id"],
                status__in=["ACTIVE", "EXECUTING"],
            ).order_by("-updated_at", "-id")
        )
        for lease in active[1:]:
            lease.status = "UNKNOWN"
            lease.result_code = "UNKNOWN"
            lease.finished_at = now
            lease.save(update_fields=["status", "result_code", "finished_at", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("reporting", "0011_alarmfact_completion_manual_required_and_more"),
    ]
    operations = [
        migrations.RemoveConstraint(
            model_name="actionlease",
            name="unique_active_fact_action_lease",
        ),
        migrations.RunPython(close_duplicate_active_leases, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="actionlease",
            constraint=models.UniqueConstraint(
                condition=models.Q(status__in=["ACTIVE", "EXECUTING"]),
                fields=("fact",),
                name="unique_active_fact_plan_lease",
            ),
        ),
    ]
