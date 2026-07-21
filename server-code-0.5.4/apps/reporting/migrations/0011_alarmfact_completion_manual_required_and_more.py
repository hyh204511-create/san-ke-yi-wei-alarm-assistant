from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('reporting', '0010_voiceinteractionevidence'),
    ]

    operations = [
        migrations.AddField(
            model_name='alarmfact',
            name='completion_manual_required',
            field=models.BooleanField(db_index=True, default=True),
        ),
        migrations.AddField(
            model_name='alarmfact',
            name='completion_reason',
            field=models.CharField(blank=True, default='', max_length=500),
        ),
        migrations.AddField(
            model_name='alarmfact',
            name='completion_source',
            field=models.CharField(blank=True, default='MANUAL_CONFIRMATION', max_length=30),
        ),
        migrations.AddField(
            model_name='alarmfact',
            name='completion_status',
            field=models.CharField(blank=True, db_index=True, default='UNKNOWN_MANUAL', max_length=30),
        ),
    ]
