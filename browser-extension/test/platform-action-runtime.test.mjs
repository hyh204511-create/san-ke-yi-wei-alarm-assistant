import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadRuntime() {
  const source = await readFile(new URL("../platform-action-runtime.js", import.meta.url), "utf8");
  const context = {
    AbortController,
    Buffer,
    Date,
    Promise,
    Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    clearTimeout,
    setTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.HnPlatformActionRuntime;
}

function platformDocument(event) {
  const cells = [
    "湖南省两客车辆",
    event.vehicleNo,
    event.alarmName,
    event.alarmTime,
  ].map((textContent) => ({ textContent }));
  const row = {
    clicked: 0,
    getAttribute: (name) => name === "row-key" ? event.alarmId : null,
    querySelectorAll: (selector) => selector === "td" ? cells : [],
    click() { this.clicked += 1; },
  };
  const selectedTab = event.sourceKind === "PREWARNING" ? "预警列表" : "实时报警";
  const tabs = ["实时报警", "预警列表"].map((label) => ({
    textContent: `${label} 1`,
    active: label === selectedTab,
    classList: { contains(name) { return name === "active" && this.owner.active; }, owner: null },
    click() {
      for (const tab of tabs) tab.active = false;
      this.active = true;
    },
  }));
  for (const tab of tabs) tab.classList.owner = tab;
  const buttons = [
    { textContent: "语音对讲" },
    { textContent: "文本下发" },
  ];
  const root = { parentElement: null, querySelectorAll: (selector) => selector === "button" ? buttons : [] };
  const vehicleNode = {
    textContent: event.vehicleNo,
    parentElement: root,
    closest: () => null,
    querySelectorAll: () => [],
  };
  return {
    row,
    querySelectorAll(selector) {
      if (selector === "table tbody tr,tr.ve-table-body-tr") return [row];
      if (selector === ".tabs .tab-item") return tabs;
      if (selector === "p,span,div") return [vehicleNode];
      return [];
    },
  };
}

function ruleAuthorization() {
  return { kind: "PUBLISHED_RESPONSE_PLAN", ruleId: "automatic-speeding", ruleSetVersion: "published-v1" };
}

function approvedEvent() {
  return {
    alarmId: "2079948988450365440",
    sourceKind: "PREWARNING",
    alarmName: "超速驾驶",
    alarmTime: "2026-07-23 00:10:00",
    vehicleId: "vehicle-test-001",
    vehicleNo: "模拟车A01(黄色)",
    certColor: "2",
  };
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("真实语音只调用固定接口并按40毫秒PCM分片形成明确回执", async () => {
  const runtime = await loadRuntime();
  const event = approvedEvent();
  const calls = [];
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(value) { this.sent.push(new Uint8Array(value).byteLength); }
    close() { this.readyState = 3; }
  }
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.authorization });
    if (url === runtime.ENDPOINTS.voiceStart) {
      return response({ success: true, data: [{ httpUrl: "wss://voice.invalid/session", fileName: "opaque-file" }] });
    }
    return response({ success: true, data: {} });
  };
  const result = await runtime.execute({
    operation: "VOICE",
    actionId: "action:test-voice",
    event,
    ruleAuthorization: ruleAuthorization(),
    authorization: "Bearer test-token",
    pcmBase64: Buffer.alloc(1280, 1).toString("base64"),
  }, {
    documentRef: platformDocument(event),
    locationRef: { hash: "#/vehicle-monitor/real-time" },
    fetchImpl,
    WebSocketImpl: FakeSocket,
    AbortControllerImpl: AbortController,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    sleepImpl: async () => {},
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.bytesSent, 1280);
  assert.deepEqual(calls.map((item) => item.url), [
    runtime.ENDPOINTS.voiceStart,
    runtime.ENDPOINTS.voiceStop,
  ]);
  assert.equal(calls.every((item) => item.authorization === "Bearer test-token"), true);
  assert.deepEqual(sockets[0].sent, [640, 640]);
});

test("文本和终端TTS与平台已处理登记保持两个独立受控阶段", async () => {
  const runtime = await loadRuntime();
  const event = approvedEvent();
  const calls = [];
  const dependencies = {
    documentRef: platformDocument(event),
    locationRef: { hash: "#/vehicle-monitor/real-time" },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({ success: true, data: {} });
    },
    AbortControllerImpl: AbortController,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    sleepImpl: async () => {},
  };
  const result = await runtime.execute({
    operation: "TEXT",
    actionId: "action:test-text",
    renderedText: runtime.SPEEDING_TEXT,
    authorization: "Bearer test-token",
    event,
    ruleAuthorization: ruleAuthorization(),
  }, dependencies);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.terminalTts, true);
  assert.deepEqual(calls.map((item) => item.url), [runtime.ENDPOINTS.textSend]);
  assert.equal(calls[0].body.msgContent, runtime.SPEEDING_TEXT);
  assert.equal(calls[0].body.tts, "1");
  const processed = await runtime.execute({
    operation: "MARK_PROCESSED",
    actionId: "action:test-processed",
    renderedText: runtime.SPEEDING_TEXT,
    authorization: "Bearer test-token",
    event,
    ruleAuthorization: ruleAuthorization(),
  }, dependencies);
  assert.equal(processed.status, "SUCCEEDED");
  assert.deepEqual(calls.map((item) => item.url), [runtime.ENDPOINTS.textSend, runtime.ENDPOINTS.markProcessed]);
  assert.equal(calls[1].body.id, event.alarmId);
});

test("平台请求发生网络异常时结果保持未知且禁止继续下一渠道", async () => {
  const runtime = await loadRuntime();
  const event = approvedEvent();
  const result = await runtime.execute({
    operation: "VOICE",
    actionId: "action:test-transport-unknown",
    event,
    ruleAuthorization: ruleAuthorization(),
    authorization: "Bearer test-token",
    pcmBase64: Buffer.alloc(1280, 1).toString("base64"),
  }, {
    documentRef: platformDocument(event),
    locationRef: { hash: "#/vehicle-monitor/real-time" },
    fetchImpl: async () => { throw new TypeError("network response lost"); },
    WebSocketImpl: class {},
    AbortControllerImpl: AbortController,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    sleepImpl: async () => {},
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.errorCode, "PLATFORM_REQUEST_FAILED");
});

test("非超速预警、错误页面和车辆行不匹配均在请求前阻断", async () => {
  const runtime = await loadRuntime();
  const event = approvedEvent();
  let calls = 0;
  const dependencies = {
    documentRef: platformDocument(event),
    locationRef: { hash: "#/vehicle-monitor/real-time" },
    fetchImpl: async () => { calls += 1; return response({ success: true }); },
    AbortControllerImpl: AbortController,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    sleepImpl: async () => {},
  };
  const wrongAlarm = await runtime.execute({
    operation: "TEXT", actionId: "a", renderedText: runtime.SPEEDING_TEXT, authorization: "Bearer test-token",
    event: { ...event, alarmName: "疲劳驾驶" },
    ruleAuthorization: ruleAuthorization(),
  }, dependencies);
  const wrongRoute = await runtime.execute({
    operation: "TEXT", actionId: "b", renderedText: runtime.SPEEDING_TEXT, authorization: "Bearer test-token", event,
    ruleAuthorization: ruleAuthorization(),
  }, { ...dependencies, locationRef: { hash: "#/alarm-center/alarm-recorde" } });
  const wrongRowDocument = platformDocument({ ...event, alarmId: "2079948988450365441" });
  const wrongRow = await runtime.execute({
    operation: "TEXT", actionId: "c", renderedText: runtime.SPEEDING_TEXT, authorization: "Bearer test-token", event,
    ruleAuthorization: ruleAuthorization(),
  }, { ...dependencies, documentRef: wrongRowDocument });
  assert.equal(wrongAlarm.status, "BLOCKED");
  assert.equal(wrongRoute.status, "BLOCKED");
  assert.equal(wrongRow.status, "BLOCKED");
  assert.equal(calls, 0);
});

test("正式报警自动选择实时报警页签并按发布规则下发文本", async () => {
  const runtime = await loadRuntime();
  const event = { ...approvedEvent(), sourceKind: "REALTIME", alarmName: "疲劳驾驶" };
  const documentRef = platformDocument(event);
  const calls = [];
  const result = await runtime.execute({
    operation: "TEXT",
    actionId: "action:formal-text",
    renderedText: "驾驶员，平台检测到疲劳驾驶报警，请立即安全停车休息。",
    authorization: "Bearer test-token",
    event,
    ruleAuthorization: { kind: "PUBLISHED_RESPONSE_PLAN", ruleId: "formal-fatigue", ruleSetVersion: "published-v2" },
  }, {
    documentRef,
    locationRef: { hash: "#/vehicle-monitor/real-time" },
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response({ success: true, data: {} }); },
    AbortControllerImpl: AbortController,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    sleepImpl: async () => {},
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(runtime.targetTabLabel(event), "实时报警");
  assert.equal(calls[0].body.msgContent, "驾驶员，平台检测到疲劳驾驶报警，请立即安全停车休息。");
});

test("当前监控页以精确报警行高亮确认车辆选择", async () => {
  const runtime = await loadRuntime();
  const event = approvedEvent();
  const documentRef = platformDocument(event);
  let selected = false;
  documentRef.row.classList = { contains: (name) => name === "ve-table-tr-highlight" && selected };
  documentRef.row.click = () => { selected = true; };
  const originalQuery = documentRef.querySelectorAll.bind(documentRef);
  documentRef.querySelectorAll = (selector) => selector === "p,span,div" ? [] : originalQuery(selector);
  const calls = [];
  const result = await runtime.execute({
    operation: "TEXT",
    actionId: "action:current-row-text",
    renderedText: runtime.SPEEDING_TEXT,
    authorization: "Bearer test-token",
    event,
    ruleAuthorization: ruleAuthorization(),
  }, {
    documentRef,
    locationRef: { hash: "#/vehicle-monitor/real-time" },
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response({ success: true, data: {} }); },
    AbortControllerImpl: AbortController,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    sleepImpl: async () => {},
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(selected, true);
  assert.equal(calls.length, 1);
});
