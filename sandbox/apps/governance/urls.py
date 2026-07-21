from django.urls import path

from . import views


urlpatterns = [
    path("", views.home, name="assistant-home"),
    path("login", views.login_page, name="assistant-login"),
    path("setup", views.setup_page, name="assistant-setup"),
    path("admin", views.admin_page, name="assistant-admin"),
    path("admin/actions/<str:operation>", views.admin_action_page, name="assistant-admin-action"),
    path("logout", views.logout_page, name="assistant-logout"),
    path("shift/claim", views.claim_shift_page, name="assistant-shift-claim"),
    path("shift/release", views.release_shift_page, name="assistant-shift-release"),
    path("api/me", views.current_user, name="assistant-current-user"),
    path("api/csrf", views.csrf_token_api, name="assistant-csrf-api"),
    path("api/action-token", views.action_token_api, name="assistant-action-token-api"),
    path("api/shifts/claim", views.claim_shift_api, name="assistant-shift-claim-api"),
    path("api/shifts/release", views.release_shift_api, name="assistant-shift-release-api"),
    path("api/users", views.users_api, name="assistant-users-api"),
    path("api/users/<int:user_id>/roles/assign", views.assign_role_api, name="assistant-role-assign-api"),
    path("api/users/<int:user_id>/roles/deactivate", views.deactivate_role_api, name="assistant-role-deactivate-api"),
    path("api/users/<int:user_id>/enterprises/grant", views.grant_enterprise_api, name="assistant-enterprise-grant-api"),
    path("governance/api/session-keepalive/policy", views.session_keepalive_policy_api, name="assistant-session-keepalive-policy-api"),
    path("governance/api/voice-interaction/policy", views.voice_interaction_policy_api, name="assistant-voice-interaction-policy-api"),
    path("governance/api/session-keepalive/audits", views.session_keepalive_audit_api, name="assistant-session-keepalive-audit-api"),
    path("governance/api/devices/heartbeat", views.device_heartbeat_api, name="assistant-device-heartbeat-api"),
]
