from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("governance", "0002_duty_shift")]
    operations = [
        migrations.AddConstraint(
            model_name="dutyshift",
            constraint=models.UniqueConstraint(
                condition=models.Q(("ended_at__isnull", True)),
                fields=("platform_account_ref",),
                name="unique_active_shift_per_platform_account",
            ),
        ),
    ]
