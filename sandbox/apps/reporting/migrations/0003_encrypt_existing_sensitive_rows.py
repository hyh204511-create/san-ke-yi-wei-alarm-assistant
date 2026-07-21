import json

from django.db import migrations


TABLE = "assistant_alarm_facts"
COLUMNS = ["event_snapshot", "decision_snapshot", "action_snapshot"]


def transform(schema_editor, encrypt):
    from apps.governance.encrypted_fields import PREFIX, decrypt_json, encrypt_json
    connection = schema_editor.connection
    quote = connection.ops.quote_name
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT {quote('id')}, {', '.join(quote(column) for column in COLUMNS)} FROM {quote(TABLE)}")
        rows = cursor.fetchall()
        for row in rows:
            updates = []
            params = []
            for column, value in zip(COLUMNS, row[1:]):
                if value is None:
                    continue
                text = str(value)
                if encrypt and not text.startswith(PREFIX):
                    try: data = json.loads(text)
                    except json.JSONDecodeError: data = text
                    value = encrypt_json(data)
                elif not encrypt and text.startswith(PREFIX):
                    value = json.dumps(decrypt_json(text), ensure_ascii=False, separators=(",", ":"))
                else:
                    continue
                updates.append(f"{quote(column)} = %s")
                params.append(value)
            if updates:
                params.append(row[0])
                cursor.execute(f"UPDATE {quote(TABLE)} SET {', '.join(updates)} WHERE {quote('id')} = %s", params)


def forward(apps, schema_editor):
    transform(schema_editor, True)


def reverse(apps, schema_editor):
    transform(schema_editor, False)


class Migration(migrations.Migration):
    dependencies = [("reporting", "0002_encrypt_sensitive_snapshots")]
    operations = [migrations.RunPython(forward, reverse)]

