from django.urls import path

from . import views


urlpatterns = [
    path("", views.home, name="disposal-home"),
    path("api/cases", views.list_api, name="disposal-list-api"),
    path("api/cases/upsert", views.upsert_api, name="disposal-upsert-api"),
    path("api/cases/<uuid:case_id>/takeover", views.takeover_api, name="disposal-takeover-api"),
    path("api/cases/<uuid:case_id>/notes", views.note_api, name="disposal-note-api"),
    path("api/cases/<uuid:case_id>/complete", views.complete_api, name="disposal-complete-api"),
    path("api/cases/<uuid:case_id>/review", views.review_api, name="disposal-review-api"),
    path("api/cases/<uuid:case_id>/reopen", views.reopen_api, name="disposal-reopen-api"),
]

