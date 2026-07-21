import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [
        migrations.CreateModel(
            name="EnterpriseScope",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("code", models.CharField(max_length=100, unique=True)),
                ("name", models.CharField(max_length=200)),
                ("scope_type", models.CharField(choices=[("GROUP", "集团"), ("BRANCH", "分公司"), ("ENTERPRISE", "企业")], max_length=20)),
                ("is_active", models.BooleanField(default=True)),
                ("parent", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="children", to="governance.enterprisescope")),
            ],
            options={"db_table": "assistant_enterprise_scopes", "ordering": ["code"]},
        ),
        migrations.CreateModel(
            name="AssistantProfile",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("display_name", models.CharField(max_length=100)),
                ("employee_code", models.CharField(max_length=100, unique=True)),
                ("is_active", models.BooleanField(default=True)),
                ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="assistant_profile", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "assistant_profiles"},
        ),
        migrations.CreateModel(
            name="RoleAssignment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("role", models.CharField(choices=[("MONITOR", "监控值班员"), ("DISPOSAL_REVIEWER", "处置复核员"), ("RULE_CONFIGURER", "规则配置员"), ("RULE_REVIEWER", "规则审核员"), ("REPORTER", "报表员"), ("SYSTEM_ADMIN", "系统管理员"), ("SECURITY_AUDITOR", "安全审计员")], max_length=32)),
                ("is_active", models.BooleanField(default=True)),
                ("assigned_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="assigned_assistant_roles", to=settings.AUTH_USER_MODEL)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="assistant_roles", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "assistant_role_assignments"},
        ),
        migrations.CreateModel(
            name="EnterpriseGrant",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("can_view_sensitive", models.BooleanField(default=False)),
                ("enterprise", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="user_grants", to="governance.enterprisescope")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="assistant_enterprise_grants", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "assistant_enterprise_grants"},
        ),
        migrations.CreateModel(
            name="AuditEvent",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("event_type", models.CharField(db_index=True, max_length=80)),
                ("object_type", models.CharField(max_length=80)),
                ("object_id", models.CharField(max_length=200)),
                ("role_snapshot", models.JSONField(default=list)),
                ("enterprise_scope_snapshot", models.JSONField(default=list)),
                ("detail", models.JSONField(default=dict)),
                ("request_id", models.CharField(blank=True, default="", max_length=100)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("actor", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="assistant_audit_events", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "assistant_audit_events", "ordering": ["-created_at"]},
        ),
        migrations.AddConstraint(model_name="roleassignment", constraint=models.UniqueConstraint(fields=("user", "role"), name="unique_assistant_user_role")),
        migrations.AddIndex(model_name="roleassignment", index=models.Index(fields=["user", "is_active"], name="assistant_role_user_active_idx")),
        migrations.AddConstraint(model_name="enterprisegrant", constraint=models.UniqueConstraint(fields=("user", "enterprise"), name="unique_assistant_user_enterprise")),
        migrations.AddIndex(model_name="enterprisegrant", index=models.Index(fields=["user", "enterprise"], name="assistant_grant_user_scope_idx")),
        migrations.AddIndex(model_name="auditevent", index=models.Index(fields=["object_type", "object_id", "-created_at"], name="assistant_audit_object_idx")),
    ]
