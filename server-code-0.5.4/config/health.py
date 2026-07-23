import logging

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.http import JsonResponse
from django.views.decorators.http import require_GET


logger = logging.getLogger("assistant.health")


@require_GET
def health(request):
    """Liveness endpoint that does not require a database round trip."""
    return JsonResponse({"ok": True, "service": "three-passenger-one-danger-assistant"})


@require_GET
def ready(request):
    """Verify the PostgreSQL runtime, writable connection and migration state."""
    try:
        if connection.vendor != "postgresql":
            return JsonResponse({
                "ok": False,
                "code": "POSTGRESQL_REQUIRED",
                "database": {"engine": connection.vendor, "writable": False, "migrations_applied": False},
            }, status=503)
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
            cursor.execute("SHOW transaction_read_only")
            writable = cursor.fetchone()[0].lower() == "off"
            if writable:
                cursor.execute("UPDATE assistant_device_registrations SET id = id WHERE 1 = 0")
        executor = MigrationExecutor(connection)
        migrations_applied = not executor.migration_plan(executor.loader.graph.leaf_nodes())
    except Exception:
        logger.warning("assistant_readiness_database_failed")
        return JsonResponse({"ok": False, "code": "DATABASE_UNAVAILABLE"}, status=503)
    ok = writable and migrations_applied
    return JsonResponse({
        "ok": ok,
        "service": "three-passenger-one-danger-assistant",
        "database": {
            "engine": "postgresql",
            "writable": writable,
            "migrations_applied": migrations_applied,
        },
        **({"code": "DATABASE_NOT_READY"} if not ok else {}),
    }, status=200 if ok else 503)
