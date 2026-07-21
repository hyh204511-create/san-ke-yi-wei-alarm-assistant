from django.urls import path

from . import views

urlpatterns = [
    path("", views.page, name="sandbox-page"),
    path("sandbox/assets/rules.json", views.sample_rules),
    path("sandbox/assets/audio-sandbox-v1.wav", views.sample_wav),
    path("health", views.health),
    path("ready", views.health),
    path("sandbox/api/scenario", views.scenario),
    path("sandbox/api/reset", views.reset),
    path("sandbox/api/trigger-alarm", views.trigger_alarm),
    path("sandbox/api/intercom/simulate", views.intercom_simulate),
    path("sandbox/api/text/simulate", views.text_simulate),
    path("api/alarm-service/alarmUserSet/listAll", views.alarm_types),
    path("api/alarm-service/alarm/center/getVideoUnprocessedAlarm", views.realtime),
    path("api/alarm-service/alarm/center/alarmQueryList", views.alarm_query),
    path("api/alarm-service/alarm/center/queryAlarmUnDealCount", views.alarm_count),
    path("api/alarm-service/alarm/center/alarmDetails", views.alarm_details),
    path("api/alarm-service/alarm/center/technology/detection", views.technical),
    path("api/base-service/groupinfo/loadAllVehicleGroupTree", views.group_tree),
    path("api/base-service/vehicle/getMonitorCarInfo/<str:car_id>", views.vehicle_info),
    path("api/base-service/vehicle/getMonitorCarBillMapInfo", views.vehicle_types),
    path("api/base-service/checkPost/list", views.check_post),
]
