import logging

from django.db import connection
from django.http import JsonResponse
from django.views.decorators.http import require_GET


logger = logging.getLogger("assistant.health")


@require_GET
def health(request):
    """Liveness endpoint that does not require a database round trip."""
    return JsonResponse({"ok": True, "service": "three-passenger-one-danger-assistant"})


@require_GET
def ready(request):
    """Readiness endpoint; never exposes database connection details."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        logger.warning("assistant_readiness_database_failed")
        return JsonResponse({"ok": False, "code": "DATABASE_UNAVAILABLE"}, status=503)
    return JsonResponse({"ok": True, "service": "three-passenger-one-danger-assistant", "database": "ok"})
