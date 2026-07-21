import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("governance", "0003_unique_active_platform_account"),
    ]
    operations = [
        migrations.CreateModel(
            name="RulePackage",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("version", models.CharField(max_length=100, unique=True)),
                ("status", models.CharField(choices=[("DRAFT", "草稿"), ("IN_REVIEW", "审核中"), ("APPROVED", "已批准"), ("REJECTED", "已驳回"), ("PUBLISHED", "已发布"), ("RETIRED", "已退役")], db_index=True, default="DRAFT", max_length=20)),
                ("payload", models.JSONField(default=dict)),
                ("content_hash", models.CharField(blank=True, db_index=True, default="", max_length=64)),
                ("change_note", models.CharField(max_length=500)),
                ("submitted_at", models.DateTimeField(blank=True, null=True)),
                ("reviewed_at", models.DateTimeField(blank=True, null=True)),
                ("review_comment", models.CharField(blank=True, default="", max_length=1000)),
                ("published_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("retired_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("based_on", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="derived_versions", to="rule_governance.rulepackage")),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="created_rule_packages", to=settings.AUTH_USER_MODEL)),
                ("enterprise_scopes", models.ManyToManyField(blank=True, related_name="rule_packages", to="governance.enterprisescope")),
                ("reviewed_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="reviewed_rule_packages", to=settings.AUTH_USER_MODEL)),
                ("rollback_of", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="rollback_versions", to="rule_governance.rulepackage")),
            ],
            options={"db_table": "assistant_rule_packages", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="RuleReviewEvent",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("action", models.CharField(choices=[("CREATED", "已创建"), ("UPDATED", "已更新"), ("SUBMITTED", "已提交"), ("APPROVED", "已批准"), ("REJECTED", "已驳回"), ("PUBLISHED", "已发布"), ("RETIRED", "已退役"), ("ROLLED_BACK", "已回滚")], db_index=True, max_length=20)),
                ("comment", models.CharField(blank=True, default="", max_length=1000)),
                ("content_hash_snapshot", models.CharField(max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("actor", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="rule_review_events", to=settings.AUTH_USER_MODEL)),
                ("rule_package", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="review_events", to="rule_governance.rulepackage")),
            ],
            options={"db_table": "assistant_rule_review_events", "ordering": ["created_at"]},
        ),
        migrations.AddIndex(model_name="rulepackage", index=models.Index(fields=["status", "-created_at"], name="rule_pkg_status_created_idx")),
        migrations.AddIndex(model_name="rulepackage", index=models.Index(fields=["-published_at"], name="rule_pkg_published_idx")),
        migrations.AddIndex(model_name="rulereviewevent", index=models.Index(fields=["rule_package", "created_at"], name="rule_review_pkg_time_idx")),
    ]
