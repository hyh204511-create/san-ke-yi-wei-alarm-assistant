from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("governance", "0009_role_boundaries")]

    operations = [
        migrations.AddField(
            model_name="enterprisescope",
            name="allow_platform_enterprise_discovery",
            field=models.BooleanField(default=False),
        ),
    ]
