from django.urls import path

from . import views


urlpatterns = [
    path("", views.home, name="response-asset-home"),
    path("actions/create", views.create_page, name="response-asset-create-page"),
    path("actions/<uuid:asset_id>/submit", views.submit_page, name="response-asset-submit-page"),
    path("actions/<uuid:asset_id>/approve", views.approve_page, name="response-asset-approve-page"),
    path("actions/<uuid:asset_id>/reject", views.reject_page, name="response-asset-reject-page"),
    path("actions/<uuid:asset_id>/publish", views.publish_page, name="response-asset-publish-page"),
    path("api/assets", views.list_api, name="response-asset-list-api"),
    path("api/assets/create", views.create_api, name="response-asset-create-api"),
    path("api/assets/<uuid:asset_id>/update", views.update_api, name="response-asset-update-api"),
    path("api/assets/<uuid:asset_id>/submit", views.submit_api, name="response-asset-submit-api"),
    path("api/assets/<uuid:asset_id>/approve", views.approve_api, name="response-asset-approve-api"),
    path("api/assets/<uuid:asset_id>/reject", views.reject_api, name="response-asset-reject-api"),
    path("api/assets/<uuid:asset_id>/publish", views.publish_api, name="response-asset-publish-api"),
    path("api/runtime", views.runtime_api, name="response-asset-runtime-api"),
]
