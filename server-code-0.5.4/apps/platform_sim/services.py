import copy
import time
from dataclasses import dataclass

from .data import ALARM_TYPES, ALARMS, GROUP_TREE
from .models import IntercomAttempt, SandboxState, TextAttempt


class SandboxError(Exception):
    def __init__(self, message, code="BAD_REQUEST", status=400):
        super().__init__(message)
        self.code = code
        self.status = status


def get_state():
    state, _ = SandboxState.objects.get_or_create(singleton=1)
    return state


def set_scenario(name):
    choices = {value for value, _ in SandboxState.SCENARIOS}
    if name not in choices:
        raise SandboxError(f"未知场景: {name}", "INVALID_SCENARIO")
    state = get_state()
    state.scenario = name
    state.save(update_fields=["scenario", "updated_at"])
    return state


def reset_state():
    state = get_state()
    state.scenario = "normal"
    state.active_alarm_id = ""
    state.save()
    IntercomAttempt.objects.all().delete()
    return state


def apply_scenario(state):
    if state.scenario == "slow":
        time.sleep(1.2)
    if state.scenario == "unauthorized":
        raise SandboxError("登录状态已失效，请重新登录", "UNAUTHORIZED", 401)
    if state.scenario == "server_error":
        raise SandboxError("模拟服务内部异常", "SYS_ERROR", 500)


def all_alarms():
    rows = copy.deepcopy(ALARMS)
    for page in (2, 3):
        for index, source in enumerate(ALARMS):
            row = copy.deepcopy(source)
            row["id"] = str(int(source["id"]) - page * 100000 - index)
            row["alarmTime"] = f"2026-06-{18 - page:02d} {18 - index // 2:02d}:{(index * 7) % 60:02d}:00"
            rows.append(row)
    return rows


def transform_rows(rows, state):
    result = copy.deepcopy(rows)
    if state.scenario == "duplicate" and result:
        result.insert(1, copy.deepcopy(result[0]))
    if state.scenario == "missing_fields":
        for row in result:
            row.pop("driverName", None)
            row.pop("companyName", None)
            row.pop("location", None)
    return result


def query_alarms(payload, state):
    apply_scenario(state)
    rows = all_alarms()
    filters = {
        "id": payload.get("alarmId") or payload.get("id"),
        "certId": payload.get("certId") or payload.get("vehicleNo"),
        "driverName": payload.get("driverName"),
        "companyId": payload.get("groupId") or payload.get("companyId"),
        "alarmTypeId": payload.get("alarmTypeId"),
    }
    for field, value in filters.items():
        if value:
            rows = [row for row in rows if str(value).lower() in str(row.get(field, "")).lower()]
    try:
        page_num = max(int(payload.get("pageNum", 1)), 1)
        page_size = min(max(int(payload.get("pageSize", 10)), 1), 100)
    except (TypeError, ValueError) as exc:
        raise SandboxError("pageNum/pageSize 必须是整数", "INVALID_PAGINATION") from exc
    start = (page_num - 1) * page_size
    page_rows = transform_rows(rows[start:start + page_size], state)
    if state.scenario == "schema_changed":
        return {"success": True, "result": {"records": page_rows, "totalCount": len(rows)}, "schemaVersion": "changed-v2"}
    return {"success": True, "total": len(rows), "dataCount": len(page_rows), "data": page_rows}


def realtime_alarms(state):
    apply_scenario(state)
    if not state.active_alarm_id:
        return {"success": True, "data": []}
    rows = all_alarms()
    row = next((item for item in rows if item["id"] == state.active_alarm_id), None)
    if row is None:
        source = rows[10 + max(state.popup_serial - 1, 0) % max(len(rows) - 10, 1)]
        row = copy.deepcopy(source)
        row["id"] = state.active_alarm_id
    rows = transform_rows([row], state)
    return {"success": True, "data": rows, "popupSerial": state.popup_serial}


def trigger_alarm(alarm_id=None):
    rows = all_alarms()
    state = get_state()
    selected = next((row for row in rows if row["id"] == str(alarm_id)), None) if alarm_id else None
    if selected is None:
        selected = rows[10 + state.popup_serial % max(len(rows) - 10, 1)]
        selected = copy.deepcopy(selected)
        selected["id"] = str(9100000000000000000 + state.popup_serial + 1)
    state.active_alarm_id = selected["id"]
    state.popup_serial += 1
    state.save(update_fields=["active_alarm_id", "popup_serial", "updated_at"])
    return selected, state


def alarm_details(payload, state):
    apply_scenario(state)
    alarm_id = payload.get("id") or payload.get("alarmId")
    if not alarm_id:
        raise SandboxError("报警记录ID不能为空", "MISSING_ALARM_ID")
    row = next((item for item in all_alarms() if item["id"] == str(alarm_id)), None)
    if row is None and str(alarm_id) == state.active_alarm_id:
        rows = all_alarms()
        row = copy.deepcopy(rows[10 + max(state.popup_serial - 1, 0) % max(len(rows) - 10, 1)])
        row["id"] = state.active_alarm_id
    if not row:
        raise SandboxError("报警记录不存在", "NOT_FOUND", 404)
    detail = transform_rows([row], state)[0]
    detail.update({
        "evidence": {
            "mapLabels": ["模拟地标A", "模拟地标B"],
            "imageAvailable": True,
            "videoAvailable": state.scenario != "missing_fields",
            "speedSeries": [61, 61, 62, 60, 60],
            "pulseSeries": [0, 0, 0, 0, 0],
        }
    })
    return {"success": True, "data": detail}


def vehicle_info(car_id, state):
    apply_scenario(state)
    row = next((item for item in all_alarms() if item["carId"] == car_id), None)
    if not row:
        raise SandboxError("车辆不存在", "NOT_FOUND", 404)
    return {"success": True, "data": {**row, "onlineStatus": "1", "longitude": 0.0, "latitude": 0.0, "positionSynthetic": True}}


def simulate_intercom(payload, state):
    car_id = str(payload.get("carId") or "")
    alarm_id = str(payload.get("alarmId") or "")
    audio_asset_id = str(payload.get("audioAssetId") or "")
    spoken_text = str(payload.get("spokenText") or "").strip()
    source = str(payload.get("source") or "")
    if not alarm_id:
        raise SandboxError("报警ID不能为空", "MISSING_ALARM_ID")
    if not car_id:
        raise SandboxError("车辆ID不能为空", "MISSING_CAR_ID")
    from apps.response_governance.models import ResponseAsset
    published_voice = ResponseAsset.objects.filter(asset_key=audio_asset_id, channel_type="VOICE", status="PUBLISHED").exists()
    if audio_asset_id != "audio-sandbox-v1" and not published_voice:
        raise SandboxError("只能使用沙箱固定测试音频", "INVALID_AUDIO_ASSET")
    if source not in {"browser-extension-sandbox-adapter", "sandbox-page-button"}:
        raise SandboxError("未知的沙箱对讲调用来源", "INVALID_SOURCE")
    if source == "browser-extension-sandbox-adapter" and (not spoken_text or len(spoken_text) > 500):
        raise SandboxError("模拟语音固定话术无效", "INVALID_SPOKEN_TEXT")
    rows = all_alarms()
    row = next((item for item in rows if item["id"] == alarm_id), None)
    if row is None and alarm_id == state.active_alarm_id:
        row = copy.deepcopy(rows[10 + max(state.popup_serial - 1, 0) % max(len(rows) - 10, 1)])
        row["id"] = state.active_alarm_id
    if row and row["carId"] != car_id:
        raise SandboxError("报警与车辆不匹配", "ALARM_VEHICLE_MISMATCH", 409)
    if source == "sandbox-page-button" and not row:
        raise SandboxError("报警与车辆不匹配", "ALARM_VEHICLE_MISMATCH", 409)
    failed = state.scenario == "intercom_failure"
    response = {"success": not failed, "errCode": "INTERCOM_FAILED" if failed else None, "errMessage": "模拟对讲通道建立失败" if failed else None, "data": {"receiptId": f"sandbox-{state.popup_serial}", "accepted": not failed, "played": False, "simulatedOnly": True}}
    safe_request = {"alarmId": alarm_id, "carId": car_id, "audioAssetId": audio_asset_id, "spokenText": spoken_text, "source": source}
    IntercomAttempt.objects.create(alarm_id=alarm_id, vehicle_id=car_id, result="FAILED" if failed else "SUCCEEDED", request_payload=safe_request, response_payload=response)
    if failed:
        raise SandboxError("模拟对讲通道建立失败", "INTERCOM_FAILED", 503)
    return response


def simulate_text(payload, state):
    car_id = str(payload.get("carId") or "")
    alarm_id = str(payload.get("alarmId") or "")
    asset_key = str(payload.get("assetKey") or "")
    rendered_text = str(payload.get("renderedText") or "")
    recipient_type = str(payload.get("recipientType") or "")
    terminal_tts = payload.get("terminalTts") is True
    source = str(payload.get("source") or "")
    if not alarm_id or not car_id:
        raise SandboxError("报警ID和车辆ID不能为空", "MISSING_TEXT_TARGET")
    if source != "browser-extension-sandbox-text-adapter":
        raise SandboxError("未知的沙箱文本调用来源", "INVALID_SOURCE")
    if not recipient_type or not rendered_text or len(rendered_text) > 500:
        raise SandboxError("文本接收对象或内容无效", "INVALID_TEXT_PAYLOAD")
    from apps.response_governance.models import ResponseAsset
    asset = ResponseAsset.objects.filter(asset_key=asset_key, channel_type="TEXT", status="PUBLISHED").first()
    if not asset:
        raise SandboxError("只能使用已发布固定文本资产", "INVALID_TEXT_ASSET")
    rows = all_alarms()
    row = next((item for item in rows if item["id"] == alarm_id), None)
    if row is None and alarm_id == state.active_alarm_id:
        row = copy.deepcopy(rows[10 + max(state.popup_serial - 1, 0) % max(len(rows) - 10, 1)])
        row["id"] = state.active_alarm_id
    if row and row["carId"] != car_id:
        raise SandboxError("报警与车辆不匹配", "ALARM_VEHICLE_MISMATCH", 409)
    values = {"vehicleNo": (row or {}).get("certId"), "alarmName": (row or {}).get("alarmName"), "alarmTime": (row or {}).get("alarmTime"), "companyName": (row or {}).get("companyName"), "location": (row or {}).get("location")}
    expected = asset.text_template
    for key, value in values.items():
        expected = expected.replace("{" + key + "}", str(value or ""))
    if rendered_text != expected:
        raise SandboxError("下发文本与已发布固定模板不一致", "TEXT_TEMPLATE_MISMATCH", 409)
    if not terminal_tts:
        raise SandboxError("自动文本提醒必须启用终端TTS播读", "TEXT_TTS_REQUIRED", 422)
    failed = state.scenario == "text_failure"
    response = {"success": not failed, "errCode": "TEXT_FAILED" if failed else None, "errMessage": "模拟文本下发失败" if failed else None, "data": {"receiptId": f"sandbox-text-{state.popup_serial}", "accepted": not failed, "terminalTts": True, "simulatedOnly": True}}
    safe_request = {"alarmId": alarm_id, "carId": car_id, "assetKey": asset_key, "renderedText": rendered_text, "recipientType": recipient_type, "terminalTts": True, "source": source}
    TextAttempt.objects.create(alarm_id=alarm_id, vehicle_id=car_id, asset_key=asset_key, result="FAILED" if failed else "SUCCEEDED", request_payload=safe_request, response_payload=response)
    if failed:
        raise SandboxError("模拟文本下发失败", "TEXT_FAILED", 503)
    return response


def state_payload(state):
    return {
        "scenario": state.scenario,
        "popupSerial": state.popup_serial,
        "activeAlarmId": state.active_alarm_id,
        "updatedAt": state.updated_at.isoformat() if state.updated_at else None,
        "intercomAttempts": IntercomAttempt.objects.count(),
        "textAttempts": TextAttempt.objects.count(),
        "scenarios": [{"value": value, "label": label} for value, label in SandboxState.SCENARIOS],
    }
