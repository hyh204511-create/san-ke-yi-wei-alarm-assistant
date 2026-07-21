from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("governance", "0008_voiceinteractionpolicy")]

    operations = [
        migrations.AlterField(
            model_name="roleassignment",
            name="role",
            field=models.CharField(
                choices=[
                    ("UNIT_USER", "采集员（只读）"),
                    ("MONITOR_OPERATOR", "监控操作员"),
                    ("RULE_CONFIGURER", "规则配置员"),
                    ("RULE_REVIEWER", "规则审核员"),
                    ("SYSTEM_ADMIN", "系统管理员"),
                ],
                max_length=32,
            ),
        ),
    ]
