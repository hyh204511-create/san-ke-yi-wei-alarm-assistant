import test from "node:test";
import assert from "node:assert/strict";

import { executeSandboxText, SANDBOX_TEXT_URL } from "../sandbox-text.js";

test("文本沙箱适配器只发送已渲染固定文本和接收对象", async () => {
  let request = null;
  const result = await executeSandboxText({
    event: { alarmId: "9000000000000000001", vehicleId: "test-car-001" },
    action: { assetKey: "text-fatigue-v1", renderedText: "湘A测001 请安全停车", recipientType: "DRIVER_TERMINAL", terminalTts: true }
  }, {
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ success: true, data: { receiptId: "text-1", terminalTts: true } }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(request.url, SANDBOX_TEXT_URL);
  assert.equal(request.body.renderedText, "湘A测001 请安全停车");
  assert.equal(request.body.recipientType, "DRIVER_TERMINAL");
  assert.equal(request.body.terminalTts, true);
  assert.equal(result.status, "SUCCEEDED");
});

test("文本沙箱即使接口成功但缺少终端TTS回执也转失败", async () => {
  const result = await executeSandboxText({
    event: { alarmId: "1", vehicleId: "car-1" },
    action: { assetKey: "text-1", renderedText: "测试", recipientType: "DRIVER_TERMINAL", terminalTts: true }
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ success: true, data: { receiptId: "text-no-tts" } }), { status: 200 })
  });
  assert.equal(result.status, "FAILED");
  assert.match(result.error, /TTS/);
});

test("文本沙箱超时返回未知而不是伪装失败或成功", async () => {
  const result = await executeSandboxText({ event: { alarmId: "1", vehicleId: "car-1" }, action: { assetKey: "text-1", renderedText: "测试", recipientType: "DRIVER_TERMINAL", terminalTts: true } }, {
    timeoutMs: 1,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  });
  assert.equal(result.status, "UNKNOWN");
});
