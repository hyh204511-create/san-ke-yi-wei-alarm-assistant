import django.db.models.deletion
import django.utils.timezone
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("governance", "0001_initial"),
    ]
    operations = [
        migrations.CreateModel(
            name="DutyShift",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("platform_account_ref", models.CharField(max_length=120)),
                ("workstation_id", models.CharField(max_length=120)),
                ("role_snapshot", models.JSONField(default=list)),
                ("enterprise_scope_snapshot", models.JSONField(default=list)),
                ("started_at", models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ("ended_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="assistant_duty_shifts", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "assistant_duty_shifts", "ordering": ["-started_at"]},
        ),
        migrations.AddConstraint(model_name="dutyshift", constraint=models.UniqueConstraint(condition=models.Q(("ended_at__isnull", True)), fields=("user",), name="unique_active_shift_per_user")),
        migrations.AddConstraint(model_name="dutyshift", constraint=models.UniqueConstraint(condition=models.Q(("ended_at__isnull", True)), fields=("workstation_id",), name="unique_active_shift_per_workstation")),
        migrations.AddIndex(model_name="dutyshift", index=models.Index(fields=["platform_account_ref", "-started_at"], name="assistant_shift_platform_idx")),
    ]
