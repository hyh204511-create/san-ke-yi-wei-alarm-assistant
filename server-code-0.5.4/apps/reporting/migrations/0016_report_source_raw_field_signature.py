from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("reporting", "0015_actionlease_action_scope_key_and_more")]

    operations = [
        migrations.AddField(
            model_name="reportsourcebatch", name="raw_field_signature",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="reportsourcepage", name="raw_field_signature",
            field=models.CharField(default="", max_length=64),
            preserve_default=False,
        ),
    ]
