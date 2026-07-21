import json
import struct

from django.test import TestCase
from django.contrib.auth import get_user_model

from apps.governance.models import AssistantProfile, EnterpriseScope
from apps.response_governance.models import ResponseAsset

from .models import IntercomAttempt, TextAttempt


class PlatformContractTests(TestCase):
    def post_json(self, path, body=None):
        return self.client.post(path, data=json.dumps(body or {}), content_type="application/json")

    def published_text_asset(self):
        user = get_user_model().objects.create_user(username="sandbox-text-configurer")
        AssistantProfile.objects.create(user=user, display_name="沙箱文本配置员", employee_code="SANDBOX-TEXT")
        scope = EnterpriseScope.objects.create(code="SANDBOX-COMPANY", name="模拟运输企业一", scope_type=EnterpriseScope.ScopeType.ENTERPRISE)
        asset = ResponseAsset.objects.create(
            asset_key="text-sandbox-v1", version="v1", channel_type="TEXT", status="PUBLISHED", text_template="{vehicleNo} 发生 {alarmName}",
            content_hash="0" * 64, change_note="沙箱固定文本", created_by=user, reviewed_by=user,
        )
        asset.enterprise_scopes.set([scope])
        return asset

    def test_alarm_query_returns_text_ids_and_pagination(self):
        response = self.post_json("/api/alarm-service/alarm/center/alarmQueryList", {"pageNum": 1, "pageSize": 10})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["total"], 30)
        self.assertEqual(len(payload["data"]), 10)
        self.assertIsInstance(payload["data"][0]["id"], str)
        self.assertEqual(payload["data"][0]["id"], "9000000000000000001")
        invalid = self.post_json("/api/alarm-service/alarm/center/alarmQueryList", {"pageNum": "not-a-number"})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["errCode"], "INVALID_PAGINATION")

    def test_trigger_alarm_is_visible_to_realtime_endpoint(self):
        triggered = self.post_json("/sandbox/api/trigger-alarm", {"alarmId": "9000000000000000001"}).json()
        realtime = self.post_json("/api/alarm-service/alarm/center/getVideoUnprocessedAlarm").json()
        self.assertEqual(realtime["popupSerial"], triggered["popupSerial"])
        self.assertEqual(realtime["data"][0]["id"], "9000000000000000001")

    def test_reset_does_not_reuse_generated_alarm_id(self):
        first = self.post_json("/sandbox/api/trigger-alarm").json()["data"]["id"]
        self.post_json("/sandbox/api/reset")
        second = self.post_json("/sandbox/api/trigger-alarm").json()["data"]["id"]
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("91"))
        self.assertTrue(second.startswith("91"))

    def test_duplicate_missing_and_schema_change_scenarios(self):
        self.post_json("/sandbox/api/scenario", {"scenario": "duplicate"})
        duplicated = self.post_json("/api/alarm-service/alarm/center/alarmQueryList", {"pageSize": 10}).json()["data"]
        self.assertEqual(duplicated[0]["id"], duplicated[1]["id"])

        self.post_json("/sandbox/api/scenario", {"scenario": "missing_fields"})
        missing = self.post_json("/api/alarm-service/alarm/center/alarmQueryList", {"pageSize": 1}).json()["data"][0]
        self.assertNotIn("driverName", missing)
        self.assertNotIn("companyName", missing)

        self.post_json("/sandbox/api/scenario", {"scenario": "schema_changed"})
        changed = self.post_json("/api/alarm-service/alarm/center/alarmQueryList", {"pageSize": 1}).json()
        self.assertIn("records", changed["result"])

    def test_unauthorized_and_server_error_are_explicit(self):
        self.post_json("/sandbox/api/scenario", {"scenario": "unauthorized"})
        response = self.post_json("/api/alarm-service/alarm/center/alarmQueryList")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["errCode"], "UNAUTHORIZED")
        self.post_json("/sandbox/api/scenario", {"scenario": "server_error"})
        response = self.post_json("/api/alarm-service/alarm/center/alarmQueryList")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["errCode"], "SYS_ERROR")

    def test_intercom_failure_is_recorded(self):
        self.post_json("/sandbox/api/scenario", {"scenario": "intercom_failure"})
        response = self.post_json("/sandbox/api/intercom/simulate", {"alarmId": "9000000000000000001", "carId": "test-car-001", "audioAssetId": "audio-sandbox-v1", "spokenText": "驾驶员，平台已报警，请注意安全驾驶。", "source": "browser-extension-sandbox-adapter"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(IntercomAttempt.objects.count(), 1)
        self.assertEqual(IntercomAttempt.objects.first().result, "FAILED")

    def test_intercom_rejects_mismatched_or_unapproved_payload(self):
        invalid_audio = self.post_json("/sandbox/api/intercom/simulate", {"alarmId": "9000000000000000001", "carId": "test-car-001", "audioAssetId": "other-audio", "spokenText": "驾驶员，平台已报警，请注意安全驾驶。", "source": "browser-extension-sandbox-adapter"})
        self.assertEqual(invalid_audio.status_code, 400)
        self.assertEqual(invalid_audio.json()["errCode"], "INVALID_AUDIO_ASSET")
        mismatch = self.post_json("/sandbox/api/intercom/simulate", {"alarmId": "9000000000000000001", "carId": "test-car-002", "audioAssetId": "audio-sandbox-v1", "spokenText": "驾驶员，平台已报警，请注意安全驾驶。", "source": "browser-extension-sandbox-adapter"})
        self.assertEqual(mismatch.status_code, 409)
        self.assertEqual(IntercomAttempt.objects.count(), 0)

    def test_generated_alarm_can_complete_sandbox_intercom(self):
        triggered = self.post_json("/sandbox/api/trigger-alarm").json()["data"]
        response = self.post_json("/sandbox/api/intercom/simulate", {"alarmId": triggered["id"], "carId": triggered["carId"], "audioAssetId": "audio-sandbox-v1", "spokenText": "驾驶员，平台已报警，请注意安全驾驶。", "source": "browser-extension-sandbox-adapter"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["data"]["accepted"])
        self.assertFalse(response.json()["data"]["played"])

    def test_extension_can_simulate_receipts_for_non_scenario_alarm(self):
        self.published_text_asset()
        text = self.post_json("/sandbox/api/text/simulate", {
            "alarmId": "local-captured-alarm", "carId": "local-captured-vehicle", "assetKey": "text-sandbox-v1",
            "renderedText": " 发生 ", "recipientType": "DRIVER_TERMINAL", "terminalTts": True, "source": "browser-extension-sandbox-text-adapter",
        })
        self.assertEqual(text.status_code, 200)
        self.assertTrue(text.json()["data"]["simulatedOnly"])
        voice = self.post_json("/sandbox/api/intercom/simulate", {
            "alarmId": "local-captured-alarm", "carId": "local-captured-vehicle", "audioAssetId": "audio-sandbox-v1",
            "spokenText": "驾驶员，平台已报警，请注意安全驾驶。", "source": "browser-extension-sandbox-adapter",
        })
        self.assertEqual(voice.status_code, 200)
        self.assertTrue(voice.json()["data"]["simulatedOnly"])

    def test_published_fixed_text_can_complete_sandbox_delivery(self):
        self.published_text_asset()
        response = self.post_json("/sandbox/api/text/simulate", {
            "alarmId": "9000000000000000001", "carId": "test-car-001", "assetKey": "text-sandbox-v1",
            "renderedText": "湘A测001(黄) 发生 驾驶员身份识别报警", "recipientType": "DRIVER_TERMINAL", "terminalTts": True, "source": "browser-extension-sandbox-text-adapter",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(TextAttempt.objects.first().result, "SUCCEEDED")

    def test_sandbox_text_requires_terminal_tts(self):
        self.published_text_asset()
        response = self.post_json("/sandbox/api/text/simulate", {
            "alarmId": "9000000000000000001", "carId": "test-car-001", "assetKey": "text-sandbox-v1",
            "renderedText": "湘A测001(黄) 发生 驾驶员身份识别报警", "recipientType": "DRIVER_TERMINAL",
            "source": "browser-extension-sandbox-text-adapter",
        })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["errCode"], "TEXT_TTS_REQUIRED")
        self.assertEqual(TextAttempt.objects.count(), 0)

    def test_text_template_mismatch_is_rejected(self):
        self.published_text_asset()
        response = self.post_json("/sandbox/api/text/simulate", {
            "alarmId": "9000000000000000001", "carId": "test-car-001", "assetKey": "text-sandbox-v1",
            "renderedText": "自由生成的其他文本", "recipientType": "DRIVER_TERMINAL", "terminalTts": True, "source": "browser-extension-sandbox-text-adapter",
        })
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["errCode"], "TEXT_TEMPLATE_MISMATCH")

    def test_downloadable_assets_match_plugin_contract(self):
        rules = self.client.get("/sandbox/assets/rules.json").json()
        self.assertEqual(rules["rules"][0]["audioAssetId"], "audio-sandbox-v1")
        wav = self.client.get("/sandbox/assets/audio-sandbox-v1.wav")
        self.assertEqual(wav.status_code, 200)
        self.assertEqual(wav.content[:4], b"RIFF")
        self.assertEqual(struct.unpack("<I", wav.content[24:28])[0], 8000)

    def test_page_exposes_stable_dom_targets(self):
        content = self.client.get("/").content.decode("utf-8")
        self.assertIn('id="alarm-table"', content)
        self.assertIn('id="sandbox-alarm-popup"', content)
        self.assertIn('class="alarm-detail-dialog"', content)
