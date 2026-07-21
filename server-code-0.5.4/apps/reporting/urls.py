from django.urls import path

from . import views


urlpatterns = [
    path("", views.home, name="reporting-home"),
    path("actions/generate", views.generate_page, name="report-generate-page"),
    path("actions/<uuid:report_id>/publish", views.publish_page, name="report-publish-page"),
    path("actions/<uuid:report_id>/export", views.export_page, name="report-export-page"),
    path("api/events/upsert", views.event_upsert_api, name="report-event-upsert-api"),
    path("api/action-leases/acquire", views.action_lease_acquire_api, name="report-action-lease-acquire-api"),
    path("api/action-leases/<uuid:lease_id>/result", views.action_lease_result_api, name="report-action-lease-result-api"),
    path("api/notifications", views.notifications_api, name="report-notifications-api"),
    path("api/notifications/<uuid:notification_id>/ack", views.notification_ack_api, name="report-notification-ack-api"),
    path("api/action-leases/<uuid:lease_id>/voice-evidence", views.voice_evidence_api, name="report-voice-evidence-api"),
    path("api/voice-evidence/<uuid:evidence_id>/transcript", views.voice_transcript_api, name="report-voice-transcript-api"),
    path("api/voice-evidence/<uuid:evidence_id>", views.voice_evidence_detail_api, name="report-voice-evidence-detail-api"),
    path("api/snapshots", views.list_api, name="report-list-api"),
    path("api/snapshots/generate", views.generate_api, name="report-generate-api"),
    path("api/snapshots/<uuid:report_id>/publish", views.publish_api, name="report-publish-api"),
    path("api/snapshots/<uuid:report_id>/exports", views.export_api, name="report-export-api"),
    path("api/exports/<uuid:export_id>/download", views.download_api, name="report-download-api"),
]
