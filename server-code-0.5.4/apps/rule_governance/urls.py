from django.urls import path

from . import views


urlpatterns = [
    path("", views.home, name="rule-center-home"),
    path("actions/create", views.create_page, name="rule-center-create"),
    path("actions/<uuid:package_id>/submit", views.submit_page, name="rule-center-submit"),
    path("actions/<uuid:package_id>/approve", views.approve_page, name="rule-center-approve"),
    path("actions/<uuid:package_id>/reject", views.reject_page, name="rule-center-reject"),
    path("actions/<uuid:package_id>/publish", views.publish_page, name="rule-center-publish"),
    path("actions/<uuid:package_id>/rollback", views.rollback_page, name="rule-center-rollback"),
    path("api/packages", views.list_api, name="rule-packages-api"),
    path("api/packages/create", views.create_api, name="rule-package-create-api"),
    path("api/packages/<uuid:package_id>/update", views.update_api, name="rule-package-update-api"),
    path("api/packages/<uuid:package_id>/submit", views.submit_api, name="rule-package-submit-api"),
    path("api/packages/<uuid:package_id>/approve", views.approve_api, name="rule-package-approve-api"),
    path("api/packages/<uuid:package_id>/reject", views.reject_api, name="rule-package-reject-api"),
    path("api/packages/<uuid:package_id>/publish", views.publish_api, name="rule-package-publish-api"),
    path("api/packages/<uuid:package_id>/rollback", views.rollback_api, name="rule-package-rollback-api"),
    path("api/runtime", views.runtime_api, name="rule-runtime-api"),
]
