import json
import logging
import math
import struct
from functools import wraps

from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from . import services
from .data import ALARM_TYPES, GROUP_TREE

logger = logging.getLogger("sandbox.api")


def page(request):
    return render(request, "platform_sim/index.html")


def sample_rules(request):
    rules = {
        "schemaVersion": 1,
        "version": "sandbox-confirmed-v1",
        "status": "CONFIRMED",
        "updatedAt": "2026-07-18T00:00:00.000Z",
        "changeNote": "仅用于127.0.0.1契约沙箱演练",
        "rules": [{
            "id": "sandbox-identity-voice",
            "name": "沙箱身份识别报警演练语音",
            "enabled": True,
            "approvalStatus": "CONFIRMED",
            "priority": 100,
            "match": {"alarmTypeIds": ["64"], "alarmNames": ["驾驶员身份识别报警"]},
            "action": "AUTO_VOICE",
            "voiceTemplateId": "voice-sandbox-v1",
            "audioAssetId": "audio-sandbox-v1",
            "allowRealIntercom": False,
            "requireVehicleAllowlist": True,
            "failureAction": "MANUAL_REVIEW",
            "updatedAt": "2026-07-18T00:00:00.000Z",
            "changeNote": "沙箱演练规则，不允许真实对讲",
        }],
    }
    response = JsonResponse(rules, json_dumps_params={"ensure_ascii": False})
    response["Content-Disposition"] = 'attachment; filename="sandbox-rules.json"'
    return response


def sample_wav(request):
    sample_rate = 8000
    samples = [int(3200 * math.sin(2 * math.pi * 440 * index / sample_rate)) for index in range(sample_rate)]
    pcm = b"".join(struct.pack("<h", value) for value in samples)
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    response = HttpResponse(header + pcm, content_type="audio/wav")
    response["Content-Disposition"] = 'attachment; filename="audio-sandbox-v1.wav"'
    return response


def payload(request):
    if not request.body:
        return {}
    if len(request.body) > 1024 * 1024:
        raise services.SandboxError("请求体超过1MB限制", "PAYLOAD_TOO_LARGE", 413)
    try:
        value = json.loads(request.body)
    except json.JSONDecodeError as exc:
        raise services.SandboxError("请求体不是有效JSON", "INVALID_JSON") from exc
    if not isinstance(value, dict):
        raise services.SandboxError("请求体必须是JSON对象", "INVALID_JSON")
    return value


def api_view(handler):
    @wraps(handler)
    def wrapped(request, *args, **kwargs):
        try:
            response = handler(request, *args, **kwargs)
            if isinstance(response, JsonResponse):
                return response
            return JsonResponse(response, json_dumps_params={"ensure_ascii": False})
        except services.SandboxError as exc:
            return JsonResponse({"success": False, "errCode": exc.code, "errMessage": str(exc), "requestId": getattr(request, "request_id", None)}, status=exc.status, json_dumps_params={"ensure_ascii": False})
        except Exception:
            logger.exception("sandbox_api_error", extra={"request_id": getattr(request, "request_id", None), "path": request.path})
            return JsonResponse({"success": False, "errCode": "SYS_ERROR", "errMessage": "模拟服务内部异常", "requestId": getattr(request, "request_id", None)}, status=500, json_dumps_params={"ensure_ascii": False})
    return wrapped


@api_view
def health(request):
    return {"ok": True, "service": "three-passenger-one-danger-sandbox", "scenario": services.get_state().scenario}


@csrf_exempt
@require_http_methods(["GET", "POST"])
@api_view
def scenario(request):
    state = services.get_state() if request.method == "GET" else services.set_scenario(payload(request).get("scenario"))
    return {"success": True, "data": services.state_payload(state)}


@csrf_exempt
@require_http_methods(["POST"])
@api_view
def reset(request):
    return {"success": True, "data": services.state_payload(services.reset_state())}


@csrf_exempt
@require_http_methods(["POST"])
@api_view
def trigger_alarm(request):
    row, state = services.trigger_alarm(payload(request).get("alarmId"))
    return {"success": True, "data": row, "popupSerial": state.popup_serial}


@csrf_exempt
@api_view
def alarm_types(request):
    services.apply_scenario(services.get_state())
    return {"success": True, "total": len(ALARM_TYPES), "data": ALARM_TYPES}


@csrf_exempt
@api_view
def alarm_query(request):
    return services.query_alarms(payload(request), services.get_state())


@csrf_exempt
@api_view
def realtime(request):
    return services.realtime_alarms(services.get_state())


@csrf_exempt
@api_view
def alarm_count(request):
    data = payload(request)
    for key in ("alarmQueryStartTime", "alarmQueryEndTime", "groupId"):
        if not data.get(key):
            raise services.SandboxError("开始时间、结束时间、管理机构业户ID不能为空", "SYS_ERROR")
    services.apply_scenario(services.get_state())
    return {"success": True, "data": {"totalCount": 30, "unDealCount": 10}}


@csrf_exempt
@api_view
def alarm_details(request):
    return services.alarm_details(payload(request), services.get_state())


@csrf_exempt
@api_view
def technical(request):
    services.apply_scenario(services.get_state())
    return {"success": True, "data": [{"id": "tech-001", "alarmTypeId": "901", "alarmName": "设备故障报警", "alarmTime": "2026-06-17 19:20:00", "carId": "car-test", "certId": "湘A测001", "statusName": "待处理"}]}


@csrf_exempt
@api_view
def group_tree(request):
    services.apply_scenario(services.get_state())
    return {"success": True, "data": GROUP_TREE}


@csrf_exempt
@api_view
def vehicle_info(request, car_id):
    return services.vehicle_info(car_id, services.get_state())


@csrf_exempt
@api_view
def vehicle_types(request):
    services.apply_scenario(services.get_state())
    return {"success": True, "data": {row["carId"]: row["vehicleTypeName"] for row in services.all_alarms()[:10]}}


@csrf_exempt
@api_view
def check_post(request):
    services.apply_scenario(services.get_state())
    return {"success": True, "total": 30, "dataCount": 2, "data": [{"id": "check-1", "groupName": "模拟两客车辆/测试机构A", "createTime": "2026-06-17 19:20:00", "responseTime": None, "status": "0"}, {"id": "check-2", "groupName": "模拟两客车辆/测试机构B", "createTime": "2026-06-17 18:10:00", "responseTime": "2026-06-17 18:10:07", "status": "1"}]}


@csrf_exempt
@require_http_methods(["POST"])
@api_view
def intercom_simulate(request):
    return services.simulate_intercom(payload(request), services.get_state())


@csrf_exempt
@require_http_methods(["POST"])
@api_view
def text_simulate(request):
    return services.simulate_text(payload(request), services.get_state())
