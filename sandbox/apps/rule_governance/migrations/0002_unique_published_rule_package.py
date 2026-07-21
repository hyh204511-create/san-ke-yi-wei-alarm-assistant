from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("rule_governance", "0001_initial")]
    operations = [
        migrations.AddConstraint(
            model_name="rulepackage",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "PUBLISHED")),
                fields=("status",),
                name="unique_published_rule_pkg",
            ),
        ),
    ]
