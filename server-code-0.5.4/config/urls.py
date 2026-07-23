from django.urls import include, path

from .health import health, ready

urlpatterns = [
    path("assistant/evidence/", include("apps.evidence.urls")),
    path("assistant/reports/", include("apps.reporting.urls")),
    path("assistant/responses/", include("apps.response_governance.urls")),
    path("assistant/disposals/", include("apps.disposals.urls")),
    path("assistant/rules/", include("apps.rule_governance.urls")),
    path("assistant/", include("apps.governance.urls")),
    path("health", health, name="assistant-health"),
    path("ready", ready, name="assistant-ready"),
]
