from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("reporting", "0016_report_source_raw_field_signature")]

    operations = [
        migrations.RemoveConstraint(
            model_name="capturesource",
            name="unique_device_capture",
        ),
        migrations.AddConstraint(
            model_name="capturesource",
            constraint=models.UniqueConstraint(
                fields=("fact", "device_id", "capture_id"),
                name="unique_fact_device_capture",
            ),
        ),
    ]
