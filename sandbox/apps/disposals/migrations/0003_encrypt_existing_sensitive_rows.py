import json

from django.db import migrations


TABLE = "assistant_disposal_cases"
CASE_COLUMNS = ["event_snapshot", "latest_event_snapshot", "decision_snapshot"]
EVENT_TABLE = "assistant_disposal_events"


def transform(schema_editor, table, columns, encrypt):
    from apps.governance.encrypted_fields import PREFIX, decrypt_json, encrypt_json
    connection = schema_editor.connection
    quote = connection.ops.quote_name
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT {quote('id')}, {', '.join(quote(column) for column in columns)} FROM {quote(table)}")
        rows = cursor.fetchall()
        for row in rows:
            updates = []
            params = []
            for column, value in zip(columns, row[1:]):
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
                cursor.execute(f"UPDATE {quote(table)} SET {', '.join(updates)} WHERE {quote('id')} = %s", params)


def forward(apps, schema_editor):
    transform(schema_editor, TABLE, CASE_COLUMNS, True)
    transform(schema_editor, EVENT_TABLE, ["detail"], True)


def reverse(apps, schema_editor):
    transform(schema_editor, TABLE, CASE_COLUMNS, False)
    transform(schema_editor, EVENT_TABLE, ["detail"], False)


class Migration(migrations.Migration):
    dependencies = [("disposals", "0002_encrypt_sensitive_snapshots")]
    operations = [migrations.RunPython(forward, reverse)]

