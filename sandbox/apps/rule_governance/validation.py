import hashlib
import json


AUTO_RETRY_POLICY = {
    "maxRetries": 2,
    "delaysMs": [5000, 10000],
    "retryOn": ["FAILED"],
    "maxDurationMs": 30000,
}

COMPLETION_FIELDS = {
    "platformStatus", "alarmStatus", "alarmCompleteStatus", "dealFlag", "dispositionFlag",
    "ignoreStatus", "verificationStatus", "evidenceAuditStatus", "appealResult", "positiveReportingFlag",
}
REMINDER_CATEGORIES = {"DRIVER_IMMEDIATE", "DRIVER_CORRECTION", "INTERNAL_CONFIRMATION", "HIGH_RISK_INTERNAL"}
DRIVER_REMINDER_MODES = {"VOICE_REQUIRED", "VOICE_PREFERRED", "TEXT_ONLY", "INTERNAL_ONLY", "VOICE_OR_TEXT_PENDING"}
SECONDARY_CHANNEL_MODES = {"NONE", "ON_PRIMARY_FAILURE", "AFTER_PRIMARY_SUCCESS", "MANUAL_ONLY"}
COMPLETION_SOURCES = {"PLATFORM_STATUS", "MANUAL_CONFIRMATION"}


class RulePayloadValidationError(Exception):
    def __init__(self, errors):
        super().__init__("；".join(errors))
        self.errors = errors


def canonical_payload(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def payload_hash(payload):
    return hashlib.sha256(canonical_payload(payload).encode("utf-8")).hexdigest()


def default_reminder_policy(rule):
    channels = rule.get("channels") if isinstance(rule, dict) else []
    first_channel = channels[0] if isinstance(channels, list) and channels else None
    driver_reminder = (
        "VOICE_PREFERRED" if isinstance(first_channel, dict) and first_channel.get("type") == "VOICE"
        else "TEXT_ONLY" if isinstance(first_channel, dict) and first_channel.get("type") == "TEXT"
        else "INTERNAL_ONLY"
    )
    return {
        "category": "INTERNAL_CONFIRMATION" if driver_reminder == "INTERNAL_ONLY" else "DRIVER_CORRECTION",
        "driverReminder": driver_reminder,
        "secondaryChannelMode": "NONE",
        "completion": {
            "source": "MANUAL_CONFIRMATION",
            "fields": [],
            "clearedValues": {},
            "unknownAction": "MANUAL_REVIEW",
        },
    }


def reminder_policy_for_rule(rule):
    base = default_reminder_policy(rule)
    configured = rule.get("reminderPolicy") if isinstance(rule, dict) else None
    configured = configured if isinstance(configured, dict) else {}
    completion = dict(base["completion"])
    if isinstance(configured.get("completion"), dict):
        completion.update(configured["completion"])
    return {**base, **configured, "completion": completion}


def validate_rule_payload(payload):
    errors = []
    if not isinstance(payload, dict):
        raise RulePayloadValidationError(["规则包必须是JSON对象"])
    if payload.get("schemaVersion") != 2:
        errors.append("schemaVersion必须为2")
    rules = payload.get("rules")
    if not isinstance(rules, list):
        errors.append("rules必须是数组")
        rules = []
    if len(rules) > 500:
        errors.append("单个规则包最多500条规则")
    ids = set()
    for index, rule in enumerate(rules):
        prefix = f"rules[{index}]"
        if not isinstance(rule, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not rule_id.strip() or len(rule_id) > 100:
            errors.append(f"{prefix}.id无效")
        elif rule_id in ids:
            errors.append(f"{prefix}.id重复: {rule_id}")
        else:
            ids.add(rule_id)
        if not isinstance(rule.get("enabled"), bool):
            errors.append(f"{prefix}.enabled必须是布尔值")
        if not isinstance(rule.get("priority"), (int, float)):
            errors.append(f"{prefix}.priority必须是数字")
        handling_mode = rule.get("handlingMode")
        if handling_mode not in {"AUTO", "MANUAL", "RECORD_ONLY", "DISABLED"}:
            errors.append(f"{prefix}.handlingMode无效")
        match = rule.get("match")
        if not isinstance(match, dict):
            errors.append(f"{prefix}.match必须是对象")
        channels = rule.get("channels", [])
        if not isinstance(channels, list):
            errors.append(f"{prefix}.channels必须是数组")
            channels = []
        reminder_policy = reminder_policy_for_rule(rule)
        if reminder_policy.get("category") not in REMINDER_CATEGORIES:
            errors.append(f"{prefix}.reminderPolicy.category无效")
        if reminder_policy.get("driverReminder") not in DRIVER_REMINDER_MODES:
            errors.append(f"{prefix}.reminderPolicy.driverReminder无效")
        if reminder_policy.get("secondaryChannelMode") not in SECONDARY_CHANNEL_MODES:
            errors.append(f"{prefix}.reminderPolicy.secondaryChannelMode无效")
        completion = reminder_policy.get("completion")
        if not isinstance(completion, dict) or completion.get("source") not in COMPLETION_SOURCES:
            errors.append(f"{prefix}.reminderPolicy.completion.source无效")
        else:
            fields = completion.get("fields")
            if not isinstance(fields, list) or any(field not in COMPLETION_FIELDS for field in fields):
                errors.append(f"{prefix}.reminderPolicy.completion.fields无效")
            cleared_values = completion.get("clearedValues")
            if not isinstance(cleared_values, dict):
                errors.append(f"{prefix}.reminderPolicy.completion.clearedValues必须是字段到值数组的对象")
            else:
                for field, values in cleared_values.items():
                    if field not in COMPLETION_FIELDS or not isinstance(values, list) or any(not isinstance(value, (str, int, float, bool)) for value in values):
                        errors.append(f"{prefix}.reminderPolicy.completion.clearedValues无效: {field}")
            if completion.get("unknownAction") != "MANUAL_REVIEW":
                errors.append(f"{prefix}.reminderPolicy.completion.unknownAction必须为MANUAL_REVIEW")
        if handling_mode == "AUTO" and not channels:
            errors.append(f"{prefix}自动处理必须至少配置一个响应渠道")
        if handling_mode == "AUTO" and (len(channels) < 1 or len(channels) > 2 or any(not isinstance(channel, dict) or channel.get("type") not in {"TEXT", "VOICE"} for channel in channels)):
            errors.append(f"{prefix}自动规则必须配置一个主渠道，可选一个明确的文本补充/兜底渠道")
        if handling_mode != "AUTO" and reminder_policy.get("driverReminder") == "INTERNAL_ONLY" and channels:
            errors.append(f"{prefix}内部确认规则不能配置司机提醒渠道")
        if handling_mode == "AUTO" and reminder_policy.get("driverReminder") in {"INTERNAL_ONLY", "VOICE_OR_TEXT_PENDING"}:
            errors.append(f"{prefix}当前提醒策略不能自动向司机发送")
        if handling_mode == "AUTO" and reminder_policy.get("driverReminder") == "VOICE_REQUIRED" and (not channels or channels[0].get("type") != "VOICE"):
            errors.append(f"{prefix}VOICE_REQUIRED主渠道必须为VOICE")
        if handling_mode == "AUTO" and reminder_policy.get("driverReminder") == "VOICE_PREFERRED" and (not channels or channels[0].get("type") != "VOICE"):
            errors.append(f"{prefix}VOICE_PREFERRED主渠道必须为VOICE")
        if handling_mode == "AUTO" and reminder_policy.get("driverReminder") == "TEXT_ONLY" and (not channels or channels[0].get("type") != "TEXT"):
            errors.append(f"{prefix}TEXT_ONLY主渠道必须为TEXT")
        strategy = rule.get("channelStrategy", "SINGLE" if len(channels) <= 1 else None)
        if strategy not in {"SINGLE", "SEQUENTIAL", "FALLBACK", "PARALLEL"}:
            errors.append(f"{prefix}.channelStrategy无效")
        if len(channels) > 1 and strategy == "SINGLE":
            errors.append(f"{prefix}多渠道规则不能使用SINGLE策略")
        if handling_mode == "AUTO" and len(channels) == 1 and strategy != "SINGLE":
            errors.append(f"{prefix}单渠道自动规则必须使用SINGLE策略")
        if handling_mode == "AUTO" and len(channels) == 2 and strategy not in {"FALLBACK", "SEQUENTIAL"}:
            errors.append(f"{prefix}双渠道自动规则必须使用FALLBACK或SEQUENTIAL策略")
        secondary_mode = reminder_policy.get("secondaryChannelMode")
        if handling_mode == "AUTO" and secondary_mode == "NONE" and len(channels) != 1:
            errors.append(f"{prefix}secondaryChannelMode为NONE时不得配置第二渠道")
        if handling_mode == "AUTO" and secondary_mode == "ON_PRIMARY_FAILURE" and (len(channels) != 2 or strategy != "FALLBACK"):
            errors.append(f"{prefix}失败兜底必须配置双渠道FALLBACK")
        if handling_mode == "AUTO" and secondary_mode == "AFTER_PRIMARY_SUCCESS" and (len(channels) != 2 or strategy != "SEQUENTIAL"):
            errors.append(f"{prefix}成功后补充必须配置双渠道SEQUENTIAL")
        if handling_mode == "AUTO" and secondary_mode == "MANUAL_ONLY" and len(channels) != 1:
            errors.append(f"{prefix}人工补充模式不得自动配置第二渠道")
        if handling_mode == "AUTO" and secondary_mode == "ON_PRIMARY_FAILURE" and (channels[0].get("type") != "VOICE" or channels[1].get("type") != "TEXT"):
            errors.append(f"{prefix}当前失败兜底策略必须为VOICE主渠道加TEXT_TTS第二渠道")
        if len(channels) <= 1 and strategy not in {"SINGLE", "SEQUENTIAL"}:
            errors.append(f"{prefix}单渠道规则不需要FALLBACK或PARALLEL策略")
        fallback = rule.get("fallback", "MANUAL")
        if fallback not in {"MANUAL", "RECORD_ONLY"}:
            errors.append(f"{prefix}.fallback无效")
        source_kinds = (match or {}).get("sourceKinds", []) if isinstance(match, dict) else []
        if source_kinds and (not isinstance(source_kinds, list) or any(kind not in {"REALTIME", "TECHNICAL", "PENDING", "PREWARNING", "HISTORY", "DETAIL"} for kind in source_kinds)):
            errors.append(f"{prefix}.match.sourceKinds无效")
        if handling_mode == "AUTO" and source_kinds and any(kind in {"PREWARNING", "HISTORY", "DETAIL"} for kind in source_kinds):
            errors.append(f"{prefix}预报警、历史和详情来源不能触发自动响应")
        retry_policy = rule.get("retryPolicy")
        if handling_mode == "AUTO" and retry_policy != AUTO_RETRY_POLICY:
            errors.append(f"{prefix}.retryPolicy必须固定为明确失败后5秒、10秒重试，30秒内转人工")
        seen_order = set()
        for channel_index, channel in enumerate(channels):
            channel_prefix = f"{prefix}.channels[{channel_index}]"
            if not isinstance(channel, dict):
                errors.append(f"{channel_prefix}必须是对象")
                continue
            channel_type = channel.get("type")
            if channel_type not in {"TEXT", "VOICE"}:
                errors.append(f"{channel_prefix}.type必须是TEXT或VOICE")
            order = channel.get("order")
            if not isinstance(order, int) or order < 1:
                errors.append(f"{channel_prefix}.order必须是正整数")
            elif order in seen_order:
                errors.append(f"{prefix}.channels执行顺序重复: {order}")
            else:
                seen_order.add(order)
            if channel_type == "TEXT" and not channel.get("templateId"):
                errors.append(f"{channel_prefix}文本渠道缺少templateId")
            if channel_type == "TEXT" and handling_mode == "AUTO" and channel.get("terminalTts") is not True:
                errors.append(f"{channel_prefix}.terminalTts必须为true")
            if channel_type == "VOICE" and not channel.get("assetId"):
                errors.append(f"{channel_prefix}语音渠道缺少assetId")
            if channel_type == "VOICE":
                spoken_template = channel.get("spokenTemplate")
                if not isinstance(spoken_template, str) or not spoken_template.strip() or len(spoken_template) > 500:
                    errors.append(f"{channel_prefix}.spokenTemplate必须为1至500字符")
            if channel_type == "VOICE" and handling_mode == "AUTO" and channel.get("terminalTts") is True:
                errors.append(f"{channel_prefix}VOICE渠道不能同时设置terminalTts")
            if not channel.get("recipientType"):
                errors.append(f"{channel_prefix}缺少recipientType")
    if errors:
        raise RulePayloadValidationError(errors)
    return payload
