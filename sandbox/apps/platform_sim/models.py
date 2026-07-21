from django.db import models


class SandboxState(models.Model):
    SCENARIOS = [
        ("normal", "正常流程"),
        ("duplicate", "重复报警"),
        ("missing_fields", "字段缺失"),
        ("schema_changed", "响应结构变化"),
        ("unauthorized", "登录失效"),
        ("server_error", "服务异常"),
        ("slow", "慢响应"),
        ("intercom_failure", "对讲失败"),
        ("text_failure", "文本下发失败"),
    ]
    singleton = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    scenario = models.CharField(max_length=32, choices=SCENARIOS, default="normal")
    popup_serial = models.PositiveIntegerField(default=0)
    active_alarm_id = models.CharField(max_length=32, blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "sandbox_state"


class IntercomAttempt(models.Model):
    alarm_id = models.CharField(max_length=32)
    vehicle_id = models.CharField(max_length=64)
    result = models.CharField(max_length=16)
    request_payload = models.JSONField(default=dict)
    response_payload = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "sandbox_intercom_attempt"
        ordering = ["-created_at"]


class TextAttempt(models.Model):
    alarm_id = models.CharField(max_length=32)
    vehicle_id = models.CharField(max_length=64)
    asset_key = models.CharField(max_length=100)
    result = models.CharField(max_length=16)
    request_payload = models.JSONField(default=dict)
    response_payload = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "sandbox_text_attempt"
        ordering = ["-created_at"]
