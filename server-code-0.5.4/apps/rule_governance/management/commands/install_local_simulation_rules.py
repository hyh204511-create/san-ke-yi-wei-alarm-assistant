import base64
import math
import struct

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.governance.models import AssistantProfile, EnterpriseGrant, EnterpriseScope, RoleAssignment
from apps.governance.services import assign_role
from apps.response_governance.models import ResponseAsset
from apps.response_governance.services import (
    create_draft as create_asset,
    publish_asset,
    review_asset,
    submit_for_review as submit_asset,
)
from apps.rule_governance.models import RulePackage
from apps.rule_governance.services import create_draft, publish_package, review_package, submit_for_review
from apps.rule_governance.validation import AUTO_RETRY_POLICY


RETRY_POLICY = AUTO_RETRY_POLICY
CATALOG = [
    ("driver-emergency", ["驾驶员突发情况", "驾驶员突发情况报警"], "驾驶员，平台已报警，请立即确认身体状况，保持车辆稳定并就近安全停车。"),
    ("physiological-fatigue", ["生理疲劳报警", "生理疲劳", "疲劳驾驶报警"], "驾驶员，平台已报警，您已出现生理疲劳，请立即就近安全停车休息或更换驾驶员。"),
    ("overtime-driving", ["超时驾驶报警", "超时驾驶"], "驾驶员，平台已报警，车辆即将或已经超时，请及时更换驾驶员，或就近安全停车休息不少于二十分钟。"),
    ("speeding", ["超速驾驶报警", "超速报警", "超速驾驶"], "驾驶员，平台已报警，车辆存在超速驾驶，请立即降低车速，按道路限速安全行驶。"),
    ("night-movement", ["夜间异动", "夜间异动报警"], "驾驶员，平台已报警，请确认夜间运行审批，并在确保安全的前提下按规定停车休息。"),
    ("handheld-phone", ["接打手持电话报警", "接打电话报警"], "驾驶员，平台已报警，请勿接打手持电话，集中注意力安全驾驶。"),
    ("smoking", ["抽烟报警", "吸烟报警"], "驾驶员，平台已报警，请勿吸烟，集中注意力安全驾驶。"),
    ("seat-belt", ["未系安全带报警", "安全带报警"], "驾驶员，平台已报警，请立即规范系好安全带，注意行车安全。"),
    ("distracted-driving", ["分心驾驶报警", "分心驾驶"], "驾驶员，平台已报警，请停止分心行为，不要查看手机，集中注意力安全驾驶。"),
    ("hands-off-wheel", ["手部脱离方向盘报警", "单手脱离方向盘报警", "双手脱离方向盘报警"], "驾驶员，平台已报警，请双手规范控制方向盘，集中注意力安全驾驶。"),
    ("driver-identity", ["驾驶员身份识别报警", "驾驶员身份不符报警"], "驾驶员，平台已报警，请规范使用驾驶员身份识别卡，并核对驾驶员身份信息。"),
    ("escort-identity", ["押运员身份识别报警", "押运员身份不符报警"], "驾驶员，平台已报警，请核对押运员身份，并在安全地点按规定停车处理。"),
    ("electronic-fence", ["电子围栏报警", "超范围经营报警"], "驾驶员，平台已报警，车辆已超出规定经营范围，请核对线路并按规定安全行驶。"),
    ("offline-displacement", ["离线位移报警"], "驾驶员，平台已报警，检测到车辆离线位移，请就近安全停车检查定位设备并联系企业。"),
    ("overcapacity", ["超员驾驶报警", "超员报警"], "驾驶员，平台已报警，车辆存在超员风险，请立即在安全地点停车并按规定处置。"),
    ("equipment-fault", ["设备故障报警", "摄像头偏离驾驶位报警", "设备遮挡失效报警", "设备定位异常报警", "设备异常"], "驾驶员，平台已报警，车载设备存在异常，请在安全地点停车检查并联系企业报修。"),
    ("suspected-accident", ["疑似事故报警"], "驾驶员，平台检测到疑似事故，请立即确认人员和车辆安全，必要时报警并联系企业。"),
    ("electronic-waybill", ["电子运单报警", "电子运单异常报警"], "驾驶员，平台已报警，电子运单或定位数据存在异常，请在安全地点停车核对并联系企业处理。"),
]

BUSINESS_PROFILES = {
    "driver-emergency": {"category": "DRIVER_IMMEDIATE", "driverReminder": "VOICE_REQUIRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "physiological-fatigue": {"category": "DRIVER_IMMEDIATE", "driverReminder": "VOICE_REQUIRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "overtime-driving": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "speeding": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "night-movement": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "handheld-phone": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "smoking": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "seat-belt": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "distracted-driving": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "hands-off-wheel": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_PREFERRED", "secondaryChannelMode": "ON_PRIMARY_FAILURE", "completionFields": ["alarmStatus", "alarmCompleteStatus", "platformStatus"]},
    "driver-identity": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_OR_TEXT_PENDING", "secondaryChannelMode": "MANUAL_ONLY", "completionFields": ["verificationStatus", "alarmStatus"]},
    "escort-identity": {"category": "DRIVER_CORRECTION", "driverReminder": "VOICE_OR_TEXT_PENDING", "secondaryChannelMode": "MANUAL_ONLY", "completionFields": ["verificationStatus", "alarmStatus"]},
    "electronic-fence": {"category": "INTERNAL_CONFIRMATION", "driverReminder": "INTERNAL_ONLY", "secondaryChannelMode": "NONE", "completionFields": []},
    "offline-displacement": {"category": "INTERNAL_CONFIRMATION", "driverReminder": "INTERNAL_ONLY", "secondaryChannelMode": "NONE", "completionFields": []},
    "overcapacity": {"category": "INTERNAL_CONFIRMATION", "driverReminder": "INTERNAL_ONLY", "secondaryChannelMode": "NONE", "completionFields": []},
    "equipment-fault": {"category": "INTERNAL_CONFIRMATION", "driverReminder": "INTERNAL_ONLY", "secondaryChannelMode": "NONE", "completionFields": []},
    "suspected-accident": {"category": "HIGH_RISK_INTERNAL", "driverReminder": "INTERNAL_ONLY", "secondaryChannelMode": "NONE", "completionFields": []},
    "electronic-waybill": {"category": "INTERNAL_CONFIRMATION", "driverReminder": "INTERNAL_ONLY", "secondaryChannelMode": "NONE", "completionFields": []},
}


class Command(BaseCommand):
    help = "在本机DEBUG/SQLite环境安装文本TTS或自动语音对讲的报警模拟规则和回执资产"

    def add_arguments(self, parser):
        parser.add_argument("--rule-version", default="local-sim-2026.07.21-v3")
        parser.add_argument("--channel", choices=["TEXT_TTS", "VOICE_INTERCOM"], default="TEXT_TTS")
        parser.add_argument("--allow-real-intercom", action="store_true", help="仅写入规则授权标志，真实适配器仍需单独联调")
        parser.add_argument("--replace-existing", action="store_true")

    def handle(self, *args, **options):
        engine = settings.DATABASES["default"]["ENGINE"]
        if not settings.DEBUG or engine != "django.db.backends.sqlite3":
            raise CommandError("该命令只允许在本机DEBUG/SQLite环境运行")
        scopes = list(EnterpriseScope.objects.filter(is_active=True))
        if not scopes:
            raise CommandError("请先配置至少一个有效企业范围")
        published = RulePackage.objects.filter(status=RulePackage.Status.PUBLISHED).first()
        if published and not published.version.startswith("local-sim-") and not options["replace_existing"]:
            raise CommandError("当前存在非本机模拟的已发布规则；如确认替换请显式使用 --replace-existing")

        configurer = self.service_user("local-rule-configurer", "本机模拟规则配置服务", "LOCAL-RULE-CFG", RoleAssignment.Role.RULE_CONFIGURER)
        reviewer = self.service_user("local-rule-reviewer", "本机模拟规则审核服务", "LOCAL-RULE-REV", RoleAssignment.Role.RULE_REVIEWER)
        for user in (configurer, reviewer):
            for scope in scopes:
                EnterpriseGrant.objects.get_or_create(user=user, enterprise=scope, defaults={"can_view_sensitive": False})
        scope_ids = [str(scope.public_id) for scope in scopes]
        version = str(options["rule_version"])

        rules = []
        for priority, (slug, names, message) in enumerate(CATALOG, start=1):
            channel = str(options["channel"])
            profile = BUSINESS_PROFILES.get(slug, {"category": "INTERNAL_CONFIRMATION", "driverReminder": "INTERNAL_ONLY", "secondaryChannelMode": "NONE", "completionFields": []})
            is_internal = profile["driverReminder"] in {"INTERNAL_ONLY", "VOICE_OR_TEXT_PENDING"}
            text = self.ensure_text_asset(configurer, reviewer, scope_ids, version, slug, message) if channel == "TEXT_TTS" and not is_internal else None
            voice = self.ensure_voice_asset(configurer, reviewer, scope_ids, version, slug) if channel == "VOICE_INTERCOM" and not is_internal else None
            simulation_reminder = "TEXT_ONLY" if channel == "TEXT_TTS" and not is_internal else profile["driverReminder"]
            channels = []
            if not is_internal and channel == "TEXT_TTS":
                channels = [{"type": "TEXT", "order": 1, "templateId": text.asset_key, "recipientType": "DRIVER_TERMINAL", "terminalTts": True}]
            elif not is_internal:
                channels = [{"type": "VOICE", "order": 1, "assetId": voice.asset_key, "recipientType": "DRIVER_TERMINAL", "spokenTemplate": message}]
            rules.append({
                "id": f"local-sim-{slug}",
                "enabled": True,
                "priority": 1000 - priority,
                "match": {"alarmNames": names, "sourceKinds": ["REALTIME", "TECHNICAL", "PENDING"]},
                "handlingMode": "MANUAL" if is_internal else "AUTO",
                "reminderPolicy": {
                    "category": profile["category"],
                    "driverReminder": simulation_reminder,
                    "secondaryChannelMode": "NONE" if channel == "TEXT_TTS" or is_internal else "NONE",
                    "completion": {
                        "source": "MANUAL_CONFIRMATION" if is_internal else "PLATFORM_STATUS",
                        "fields": profile["completionFields"],
                        "clearedValues": {},
                        "unknownAction": "MANUAL_REVIEW",
                    },
                },
                "channels": channels,
                "channelStrategy": "SINGLE",
                "retryPolicy": RETRY_POLICY,
                "fallback": "MANUAL",
                "allowRealIntercom": bool(options["allow_real_intercom"]),
            })
        payload = {"schemaVersion": 2, "version": version, "status": "PUBLISHED", "rules": rules}
        if published and published.version == version:
            self.stdout.write(self.style.SUCCESS(f"本机模拟规则已存在：{version}"))
            return
        package = create_draft(
            actor=configurer, version=version, payload=payload,
            change_note=f"本机模拟：{options['channel']}，明确失败后5秒、10秒重试，30秒内转人工",
            enterprise_scope_ids=scope_ids,
        )
        submit_for_review(actor=configurer, package=package)
        review_package(actor=reviewer, package=package, approved=True, comment="仅批准本机沙箱模拟，不授权真实省平台动作")
        publish_package(actor=reviewer, package=package)
        self.stdout.write(self.style.SUCCESS(f"已发布本机模拟规则：{version}，共{len(rules)}类报警"))

    def service_user(self, username, display_name, employee_code, role):
        user_model = get_user_model()
        user, created = user_model.objects.get_or_create(username=username, defaults={"is_active": True})
        if created or user.has_usable_password():
            user.set_unusable_password()
            user.save(update_fields=["password"])
        AssistantProfile.objects.get_or_create(user=user, defaults={"display_name": display_name, "employee_code": employee_code})
        assign_role(user=user, role=role, assigned_by=user)
        return user

    def ensure_text_asset(self, configurer, reviewer, scope_ids, version, slug, message):
        key = f"text-{slug}-local-v1"
        current = ResponseAsset.objects.filter(asset_key=key, status=ResponseAsset.Status.PUBLISHED).first()
        if current:
            return current
        asset = create_asset(
            actor=configurer, asset_key=key, version=version, channel_type=ResponseAsset.ChannelType.TEXT,
            enterprise_scope_ids=scope_ids, change_note="本机模拟固定文本话术", text_template=message,
        )
        submit_asset(actor=configurer, asset=asset)
        review_asset(actor=reviewer, asset=asset, approved=True, comment="仅用于本机文本模拟回执")
        return publish_asset(actor=reviewer, asset=asset)

    def ensure_voice_asset(self, configurer, reviewer, scope_ids, version, slug):
        key = f"voice-{slug}-local-v1"
        current = ResponseAsset.objects.filter(asset_key=key, status=ResponseAsset.Status.PUBLISHED).first()
        if current:
            return current
        sample_rate = 8000
        pcm = b"".join(struct.pack("<h", int(1800 * math.sin(2 * math.pi * 440 * i / sample_rate))) for i in range(sample_rate))
        wav = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm)) + pcm
        asset = create_asset(
            actor=configurer, asset_key=key, version=version, channel_type=ResponseAsset.ChannelType.VOICE,
            enterprise_scope_ids=scope_ids, change_note="本机模拟固定语音对讲资产", voice_base64=base64.b64encode(wav).decode("ascii"), voice_filename=f"{key}.wav",
        )
        submit_asset(actor=configurer, asset=asset)
        review_asset(actor=reviewer, asset=asset, approved=True, comment="仅用于本机语音对讲模拟回执")
        return publish_asset(actor=reviewer, asset=asset)
