from django.db import migrations

import apps.governance.encrypted_fields


class Migration(migrations.Migration):
    dependencies = [("reporting", "0003_encrypt_existing_sensitive_rows")]

    operations = [
        migrations.AddField(
            model_name="alarmfact",
            name="ingestion_provenance",
            field=apps.governance.encrypted_fields.EncryptedJSONField(default=list),
        ),
    ]
