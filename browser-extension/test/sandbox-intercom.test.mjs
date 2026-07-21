import test from "node:test";
import assert from "node:assert/strict";

import { executeSandboxIntercom, SANDBOX_INTERCOM_URL } from "../sandbox-intercom.js";

test("沙箱对讲适配器只调用固定本机端点并保留回执", async () => {
  let request = null;
  const result = await executeSandboxIntercom({
    event: { alarmId: "9000000000000000001", vehicleId: "test-car-001" },
    action: { audioAssetId: "audio-sandbox-v1", renderedText: "驾驶员，平台已报警，请注意安全驾驶。" },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ success: true, data: { receiptId: "sandbox-1" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(request.url, SANDBOX_INTERCOM_URL);
  assert.equal(request.body.carId, "test-car-001");
  assert.equal(request.body.source, "browser-extension-sandbox-adapter");
  assert.match(request.body.spokenText, /注意安全驾驶/);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.result.receiptId, "sandbox-1");
});

test("沙箱对讲失败不会伪装成功", async () => {
  const result = await executeSandboxIntercom({
    event: { alarmId: "1", vehicleId: "car-1" },
    action: { audioAssetId: "audio-1", renderedText: "固定模拟话术" },
    fetchImpl: async () => new Response(JSON.stringify({ success: false, errMessage: "模拟失败" }), { status: 503, headers: { "content-type": "application/json" } })
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.error, "模拟失败");
});
