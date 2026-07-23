import json

from django.apps import apps
from django.core.management.base import BaseCommand, CommandError

from apps.governance.encrypted_fields import EncryptedJSONField

MIGRATION_APP_LABELS = {
    "governance", "rule_governance", "response_governance",
    "disposals", "reporting", "evidence",
}


def migration_models():
    return [
        model for model in apps.get_models()
        if model._meta.label_lower == "auth.user" or model._meta.app_label in MIGRATION_APP_LABELS
    ]


class Command(BaseCommand):
    help = "Print model counts and verify every encrypted field without exposing business values."

    def handle(self, *args, **options):
        counts = {}
        encrypted_values = 0
        for model in migration_models():
            label = model._meta.label_lower
            queryset = model._default_manager.order_by("pk")
            counts[label] = queryset.count()
            encrypted_fields = [field for field in model._meta.fields if isinstance(field, EncryptedJSONField)]
            for field in encrypted_fields:
                try:
                    for instance in queryset.only("pk", field.name).iterator(chunk_size=500):
                        getattr(instance, field.name)
                        encrypted_values += 1
                except Exception as exc:
                    raise CommandError(f"Encrypted field verification failed for {label}.{field.name}") from exc
        self.stdout.write(json.dumps({
            "database_vendor": self._database_vendor(),
            "model_counts": counts,
            "encrypted_values_verified": encrypted_values,
        }, ensure_ascii=False, sort_keys=True))

    @staticmethod
    def _database_vendor():
        from django.db import connection
        return connection.vendor
