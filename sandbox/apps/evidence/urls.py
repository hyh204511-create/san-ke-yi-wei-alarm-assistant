from django.urls import path

from . import views


urlpatterns = [
    path("", views.home, name="evidence-home"),
    path("actions/create", views.create_page, name="evidence-create-page"),
    path("actions/<uuid:evidence_id>/approve", views.approve_page, name="evidence-approve-page"),
    path("actions/<uuid:evidence_id>/reject", views.reject_page, name="evidence-reject-page"),
    path("api/requests", views.list_api, name="evidence-list-api"),
    path("api/requests/create", views.create_api, name="evidence-create-api"),
    path("api/requests/<uuid:evidence_id>/review", views.review_api, name="evidence-review-api"),
    path("api/requests/<uuid:evidence_id>/download", views.download_api, name="evidence-download-api"),
]

