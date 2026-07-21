from django.db import migrations, models


ROLE_MAP = {
    "MONITOR": "UNIT_USER",
    "DISPOSAL_REVIEWER": "RULE_REVIEWER",
    "REPORTER": "RULE_CONFIGURER",
    "SECURITY_AUDITOR": "RULE_REVIEWER",
}


def consolidate_roles(apps, schema_editor):
    RoleAssignment = apps.get_model("governance", "RoleAssignment")
    for user_id in RoleAssignment.objects.values_list("user_id", flat=True).distinct().iterator():
        assignments = list(RoleAssignment.objects.filter(user_id=user_id).order_by("id"))
        by_target = {}
        for assignment in assignments:
            target = ROLE_MAP.get(assignment.role, assignment.role)
            current = by_target.get(target)
            if current is None:
                assignment.role = target
                assignment.save(update_fields=["role"])
                by_target[target] = assignment
                continue
            if assignment.is_active and not current.is_active:
                current.is_active = True
                current.assigned_by_id = assignment.assigned_by_id
                current.save(update_fields=["is_active", "assigned_by_id"])
            assignment.delete()


class Migration(migrations.Migration):
    dependencies = [("governance", "0003_unique_active_platform_account")]

    operations = [
        migrations.RunPython(consolidate_roles, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="roleassignment",
            name="role",
            field=models.CharField(
                choices=[
                    ("UNIT_USER", "单位使用人员"),
                    ("RULE_CONFIGURER", "规则配置员"),
                    ("RULE_REVIEWER", "规则审核员"),
                    ("SYSTEM_ADMIN", "系统管理员"),
                ],
                max_length=32,
            ),
        ),
    ]
