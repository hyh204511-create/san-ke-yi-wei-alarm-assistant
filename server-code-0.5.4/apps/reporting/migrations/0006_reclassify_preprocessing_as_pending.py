from django.db import migrations


def reclassify_preprocessing(apps, schema_editor):
    AlarmFact = apps.get_model("reporting", "AlarmFact")
    for fact in AlarmFact.objects.filter(source_kind="PREWARNING").iterator():
        snapshot = fact.event_snapshot if isinstance(fact.event_snapshot, dict) else {}
        if snapshot.get("rawEndpoint") not in {"prewarning-alarms", "pending-alarms"}:
            continue
        snapshot = dict(snapshot)
        snapshot["sourceKind"] = "PENDING"
        snapshot["sourceLabel"] = "待处理报警"
        snapshot["rawEndpoint"] = "pending-alarms"
        snapshot["sourceEndpoints"] = [
            "pending-alarms" if value == "prewarning-alarms" else value
            for value in snapshot.get("sourceEndpoints", [])
        ]
        fact.source_kind = "PENDING"
        fact.event_snapshot = snapshot
        fact.save(update_fields=["source_kind", "event_snapshot", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [("reporting", "0005_actionlease_capturesource_and_more")]
    operations = [migrations.RunPython(reclassify_preprocessing, migrations.RunPython.noop)]
