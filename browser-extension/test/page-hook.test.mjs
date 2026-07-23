import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const hookCode = await readFile(new URL("../page-hook.js", import.meta.url), "utf8");

function makeContext() {
  const messages = [];
  const intervalCallbacks = [];
  const fetchCalls = [];
  const xhrInstances = [];
  let fetchVersion = 1;
  let fetchStatus = 200;
  let fetchHandler = null;
  let now = Date.parse("2026-07-23T00:00:00+08:00");
  class FakeDate extends Date {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  class FakeXHR {
    constructor() {
      xhrInstances.push(this);
      this.listeners = {};
      this.status = 200;
      this.responseType = "";
      this.withCredentials = false;
      this.timeout = 0;
      this.requestHeaders = {};
      this.responseText = JSON.stringify({
        success: true,
        data: [{ id: "a-2", alarmId: "99", alarmName: "未系安全带" }]
      });
    }
    open(method, url, ...rest) {
      this.nativeOpen = { method, url, rest };
    }
    setRequestHeader(name, value) { this.requestHeaders[name] = value; }
    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }
    getResponseHeader(name) {
      return name === "content-type" ? "application/json" : null;
    }
    send(body) {
      this.sentBody = body;
      queueMicrotask(() => this.listeners.loadend?.call(this));
    }
  }

  class FakePort {
    constructor() {
      this.listeners = [];
      this.started = false;
      this._onmessage = null;
    }
    get onmessage() {
      return this._onmessage;
    }
    set onmessage(value) {
      this._onmessage = value;
    }
    addEventListener(name, callback) {
      if (name === "message") this.listeners.push(callback);
    }
    start() {
      this.started = true;
    }
    dispatch(data) {
      const event = { data };
      this._onmessage?.(event);
      for (const listener of this.listeners) listener(event);
    }
  }

  class FakeSharedWorker {
    constructor() {
      this.port = new FakePort();
    }
  }

  const context = {
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    ArrayBuffer,
    AbortController,
    Date: FakeDate,
    XMLHttpRequest: FakeXHR,
    SharedWorker: FakeSharedWorker,
    crypto: webcrypto,
    location: {
      href: "https://hn.hnznjg.cn:7443/#/board-center",
      hash: "#/board-center",
      origin: "https://hn.hnznjg.cn:7443"
    },
    document: { visibilityState: "visible", querySelectorAll: () => [] },
    performance: { now: () => now },
    fetch: async (...args) => {
      fetchCalls.push(args);
      if (fetchHandler) return fetchHandler(...args);
      return new Response(JSON.stringify({
      success: true,
      data: [{ id: `a-${fetchVersion}`, alarmId: String(61 + fetchVersion), alarmName: "抽烟报警", ownerPhone: "synthetic-phone-value" }]
      }), { status: fetchStatus, headers: { "content-type": "application/json" } });
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval: (callback, delay) => {
      intervalCallbacks.push({ callback, delay });
      return intervalCallbacks.length;
    },
    queueMicrotask
  };
  context.window = context;
  context.window.postMessage = (message) => messages.push(message);
  vm.createContext(context);
  vm.runInContext(hookCode, context);
  return {
    context,
    messages,
    intervalCallbacks,
    fetchCalls,
    xhrInstances,
    advanceTime: (milliseconds) => { now += milliseconds; },
    setFetchVersion: (value) => { fetchVersion = value; },
    setFetchStatus: (value) => { fetchStatus = value; },
    setFetchHandler: (value) => { fetchHandler = value; }
  };
}

test("fetch 和 XHR 只读捕获报警响应并脱敏凭证", async () => {
  const { context, messages } = makeContext();
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    {
      method: "POST",
      headers: { authorization: "secret", "x-client": "collector-test" },
      body: JSON.stringify({ alarmKind: 1, token: "secret" })
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const xhr = new context.XMLHttpRequest();
  xhr.open(
    "POST",
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList"
  );
  xhr.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.length, 2);
  assert.equal(messages[0].record.matchedRule, "realtime-alarms");
  assert.equal(messages[0].record.request.headers.authorization, undefined);
  assert.equal(messages[0].record.request.body.token, "[REDACTED]");
  assert.equal(messages[0].record.response.body.data[0].alarmName, "抽烟报警");
  assert.equal(messages[0].record.response.body.data[0].ownerPhone, "[REDACTED]");
  assert.equal(messages[1].record.transport, "xhr");
  assert.equal(messages[1].record.matchedRule, "alarm-query");
});

test("unknown alarm-center endpoints are captured as discovery only", async () => {
  const source = await readFile(new URL("../page-hook.js", import.meta.url), "utf8");
  assert.match(source, /alarm-center-discovery/);
  assert.match(source, /\/alarm-service\/alarm\/center\//);
  assert.doesNotMatch(source, /category: record\.category === "discovery" \? "alarm"/);
});

test("五来源页面只读识别未知接口并保留来源类型", async () => {
  const cases = [
    ["轨迹完整率明细", "TRACK_COMPLETENESS", "report-track-completeness-discovery"],
    ["车辆基础信息", "VEHICLE_BASE_INFO", "report-vehicle-base-discovery"],
    ["处置率报表", "ALARM_DISPOSAL_RATE", "report-alarm-disposal-discovery"],
    ["处理率报表", "ALARM_PROCESSING_RATE", "report-alarm-processing-discovery"],
    ["报警查询报表", "ALARM_CENTER", "report-alarm-center-discovery"],
  ];
  for (const [label, sourceType, matchedRule] of cases) {
    const { context, messages } = makeContext();
    context.document.querySelectorAll = () => [{ className: "is-active", textContent: label, getAttribute: () => null }];
    await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/report-service/unknown/list", {
      method: "POST", body: JSON.stringify({ pageNum: 1, pageSize: 20 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].record.category, "report-discovery");
    assert.equal(messages[0].record.reportSourceType, sourceType);
    assert.equal(messages[0].record.matchedRule, matchedRule);
  }
});

test("alarmQueryList 根据页面路由区分实时报警、预报警和历史查询", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/alarm-center/alarm-verification";
  const realtime = new context.XMLHttpRequest();
  realtime.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  realtime.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  context.location.hash = "#/alarm-center/pr-alarm-recorde";
  const prewarning = new context.XMLHttpRequest();
  prewarning.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  prewarning.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  context.location.hash = "#/alarm-center/alarm-recorde";
  const history = new context.XMLHttpRequest();
  history.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  history.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages[0].record.matchedRule, "realtime-alarms");
  assert.equal(messages[0].record.route, "#/alarm-center/alarm-verification");
  assert.equal(messages[1].record.matchedRule, "prewarning-query");
  assert.equal(messages[1].record.route, "#/alarm-center/pr-alarm-recorde");
  assert.equal(messages[2].record.matchedRule, "alarm-query");
  assert.equal(messages[2].record.route, "#/alarm-center/alarm-recorde");
});

test("实时监控页内部活动页签区分正式实时报警和预警列表", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  context.document.querySelectorAll = () => [{ className: "tab-item active", textContent: "实时报警 1" }];
  const realtime = new context.XMLHttpRequest();
  realtime.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  realtime.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  context.document.querySelectorAll = () => [{ className: "tab-item active", textContent: "预警列表 66" }];
  const prewarning = new context.XMLHttpRequest();
  prewarning.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  prewarning.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages[0].record.matchedRule, "realtime-alarms");
  assert.equal(messages[1].record.matchedRule, "prewarning-query");
});

test("非活动的实时报警页签不会覆盖活动的预警列表页签", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  context.document.querySelectorAll = () => [
    { className: "tab-item inactive", textContent: "实时报警 1" },
    { className: "tab-item active", textContent: "预警列表 66" }
  ];
  const request = new context.XMLHttpRequest();
  request.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  request.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].record.matchedRule, "prewarning-query");
});

test("alarmQueryList 请求发起时页签尚未渲染，响应完成后重新归类", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  let tabReads = 0;
  context.document.querySelectorAll = () => {
    tabReads += 1;
    return tabReads === 1 ? [] : [{ className: "tab-item active", textContent: "实时报警 1" }];
  };

  const request = new context.XMLHttpRequest();
  request.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  request.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(tabReads, 2);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].record.matchedRule, "realtime-alarms");
  assert.equal(messages[0].record.route, "#/vehicle-monitor/real-time");
});

test("实时监控页活动页签无法确认时只做发现捕获，不伪装成历史查询", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  context.document.querySelectorAll = () => [];
  const request = new context.XMLHttpRequest();
  request.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList");
  request.send(JSON.stringify({ pageNum: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].record.matchedRule, "alarm-center-discovery");
  assert.equal(messages[0].record.category, "discovery");
});

test("SharedWorker 的正式报警消息归类为实时报警，预警消息不升级", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  const worker = new context.SharedWorker("/js/sharedWorker.js");
  let delivered = 0;
  worker.port.onmessage = () => { delivered += 1; };

  worker.port.dispatch({
    funCode: "ALARM_ADD",
    alarmKind: 1,
    id: "synthetic-realtime-id",
    alarmId: "synthetic-alarm-type",
    carId: "synthetic-car-id",
    certId: "湘A测001",
    alarmName: "模拟正式报警",
    contactInformation: "synthetic-phone"
  });
  worker.port.dispatch({
    funCode: "ALARM_ADD",
    alarmKind: 0,
    id: "synthetic-prewarning-id",
    alarmId: "18",
    carId: "synthetic-car-id"
  });

  assert.equal(delivered, 2);
  assert.equal(worker.port.started, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].record.transport, "shared-worker-message");
  assert.equal(messages[0].record.matchedRule, "realtime-alarms");
  assert.equal(messages[0].record.response.body.contactInformation, "[REDACTED]");
  assert.equal(messages[0].record.response.body.alarmName, "模拟正式报警");
});

test("报警预处理专用接口分别归类为统计和待处理明细", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/alarm-center/alarm-preprocessing";
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmPreProcessingCount", { method: "POST", body: "{}" });
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmPreProcessingInfo", { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(messages.map((message) => message.record.matchedRule), ["preprocessing-count", "pending-alarms"]);
});

test("real-time monitor getVideoUnprocessedAlarm is the prewarning list", async () => {
  const { context, messages } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";

  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: "{}" }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].record.matchedRule, "prewarning-query");
  assert.equal(messages[0].record.route, "#/vehicle-monitor/real-time");
});

test("平台静默后按三秒兜底轮询且相同响应不重复入库", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";

  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: JSON.stringify({ pageNum: 1 }) }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(intervalCallbacks.length, 1);
  assert.equal(intervalCallbacks[0].delay, 3000);
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.length, 2);
  assert.equal(messages[1].source, "hn-alarm-realtime-poll");
  assert.equal(messages[1].status, 200);
  assert.equal(messages[1].changed, false);
});

test("来源注册后切换页面仍保持冻结分类轮询", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: "{}" }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  context.location.hash = "#/alarm-center/alarm-recorde";
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].matchedRule, "prewarning-query");
});

test("实时轮询响应变化时立即产生新的抓取记录", async () => {
  const { context, messages, intervalCallbacks, setFetchVersion, advanceTime } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: "{}" }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  setFetchVersion(2);
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, 3);
  assert.equal(messages[1].source, "hn-alarm-realtime-poll");
  assert.equal(messages[1].changed, true);
  assert.equal(messages[2].record.transport, "fetch-poll");
  assert.equal(messages[2].record.response.body.data[0].alarmId, "63");
});

test("实时报警页签的alarmQueryList按三秒复用原请求并保持REALTIME分类", async () => {
  const { context, messages, intervalCallbacks, setFetchVersion, advanceTime } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  context.document.querySelectorAll = (selector) => selector.includes("tab-item") ? [{
    className: "tab-item active",
    classList: { contains: (name) => name === "active" },
    getAttribute: (name) => name === "aria-selected" ? "true" : null,
    textContent: "实时报警 1",
  }] : [];
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList",
    { method: "POST", body: JSON.stringify({ pageNum: 1 }) },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages[0].record.matchedRule, "realtime-alarms");
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages[1].source, "hn-alarm-realtime-poll");
  assert.equal(messages[1].changed, false);
  setFetchVersion(2);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages[3].record.matchedRule, "realtime-alarms");
  assert.equal(messages[3].record.transport, "fetch-poll");
});

test("native traffic inside the silence window suppresses fallback polling", async () => {
  const { context, messages, intervalCallbacks } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: "{}" }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, 1);
});

test("all four approved alarm sources register independent pollers", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  context.location.hash = "#/alarm-center/alarm-verification";
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList", { method: "POST", body: "{}" });
  context.location.hash = "#/vehicle-monitor/real-time";
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm", { method: "POST", body: "{}" });
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmPreProcessingInfo", { method: "POST", body: "{}" });
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection", { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const polledRules = messages
    .filter((message) => message.source === "hn-alarm-realtime-poll")
    .map((message) => message.matchedRule)
    .sort();
  assert.deepEqual(polledRules, ["pending-alarms", "prewarning-query", "realtime-alarms", "technical-alarms"]);
});

test("fallback authentication errors stop the alarm polling session", async () => {
  const { context, messages, intervalCallbacks, advanceTime, setFetchStatus } = makeContext();
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection", { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  setFetchStatus(401);
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterUnauthorized = messages.length;
  setFetchStatus(200);
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, afterUnauthorized);
});

test("fallback 403 clears every source and blocks older native responses until a new success", async () => {
  const { context, messages, intervalCallbacks, advanceTime, setFetchHandler } = makeContext();
  const technical = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  const pending = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmPreProcessingInfo";
  await context.fetch(technical, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await context.fetch(pending, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let releaseOldNative;
  let calls = 0;
  setFetchHandler(() => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { releaseOldNative = resolve; });
    if (calls === 2) return Promise.resolve(new Response("{\"error\":\"expired\"}", { status: 403, headers: { "content-type": "application/json" } }));
    return Promise.resolve(new Response(`{\"success\":true,\"call\":${calls}}`, { status: 200, headers: { "content-type": "application/json" } }));
  });
  advanceTime(5000);
  const oldNative = context.fetch(technical, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseOldNative(new Response("{\"success\":true,\"old\":true}", { status: 200, headers: { "content-type": "application/json" } }));
  await oldNative;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterFailure = messages.filter((message) => message.source === "hn-alarm-realtime-poll").length;
  advanceTime(5000);
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, afterFailure);
  await context.fetch(technical, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, afterFailure + 1);
});

test("three consecutive failures trip the per-source circuit breaker", async () => {
  const { context, messages, intervalCallbacks, advanceTime, setFetchStatus } = makeContext();
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmPreProcessingInfo", { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  setFetchStatus(500);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    advanceTime(5000);
    await intervalCallbacks[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const afterFailures = messages.length;
  setFetchStatus(200);
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, afterFailures);
});

test("fetch Request is cloned before dispatch and never reuses its aborted signal", async () => {
  const { context, fetchCalls, intervalCallbacks, advanceTime } = makeContext();
  const controller = new AbortController();
  const request = new Request(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection",
    { method: "POST", body: "{}", signal: controller.signal }
  );
  await context.fetch(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls[0][0].signal.aborted, false);
  controller.abort();
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0][0].signal.aborted, true);
  assert.equal(fetchCalls[1][0].signal.aborted, false);
});

test("XHR fallback restores transport options and does not recursively register", async () => {
  const { context, messages, xhrInstances, intervalCallbacks, advanceTime } = makeContext();
  const request = new context.XMLHttpRequest();
  request.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection", true, "user", "pass");
  request.withCredentials = true;
  request.timeout = 7654;
  request.responseType = "text";
  request.setRequestHeader("x-client", "alarm-test");
  request.send("{}");
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(xhrInstances.length, 2);
  assert.deepEqual(xhrInstances[1].nativeOpen.rest, [true, "user", "pass"]);
  assert.equal(xhrInstances[1].withCredentials, true);
  assert.equal(xhrInstances[1].timeout, 7654);
  assert.equal(xhrInstances[1].responseType, "text");
  assert.equal(xhrInstances[1].requestHeaders["x-client"], "alarm-test");
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 1);
});

test("poller registry is capped at eight observed request variants", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  const url = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  for (let index = 0; index < 9; index += 1) {
    await context.fetch(url, { method: "POST", body: JSON.stringify({ pageNum: index + 1 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 8);
});

test("check-post appeal and action endpoints are never fallback-polled", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  const urls = [
    "https://zuul-2k1v.hnznjg.cn:7443/api/base-service/checkPost/list",
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/appeal",
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/sendText"
  ];
  for (const url of urls) await context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 0);
});

test("approved paths require exact pathname and POST method", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  const base = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  await context.fetch(`${base}/markHandled`, { method: "POST", body: "{}" });
  await context.fetch(base, { method: "PUT", body: "{}" });
  await context.fetch(base, { method: "DELETE", body: "{}" });
  await context.fetch(base, { method: "PATCH", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 0);
});

test("a slow native request immediately suppresses an existing fallback poller", async () => {
  const { context, messages, intervalCallbacks, advanceTime, setFetchHandler } = makeContext();
  const url = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  await context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  let releaseNative;
  setFetchHandler(() => new Promise((resolve) => { releaseNative = resolve; }));
  const nativeRequest = context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 0);
  releaseNative(new Response("{\"success\":true,\"data\":[]}", { status: 200, headers: { "content-type": "application/json" } }));
  await nativeRequest;
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("registry capacity keeps at least one poller for every observed alarm source", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  const technical = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  for (let index = 0; index < 8; index += 1) {
    await context.fetch(technical, { method: "POST", body: JSON.stringify({ pageNum: index + 1 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  context.location.hash = "#/alarm-center/alarm-verification";
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList", { method: "POST", body: "{}" });
  context.location.hash = "#/vehicle-monitor/real-time";
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm", { method: "POST", body: "{}" });
  await context.fetch("https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmPreProcessingInfo", { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rules = new Set(messages
    .filter((message) => message.source === "hn-alarm-realtime-poll")
    .map((message) => message.matchedRule));
  assert.deepEqual([...rules].sort(), ["pending-alarms", "prewarning-query", "realtime-alarms", "technical-alarms"]);
});

test("capture URLs redact sensitive query parameters", async () => {
  const { context, messages } = makeContext();
  context.location.href = "https://hn.hnznjg.cn:7443/?token=page-secret#/vehicle-monitor/real-time";
  context.location.hash = "#/vehicle-monitor/real-time?token=route-secret";
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection?token=request-secret&code=123456&pageNum=1",
    { method: "POST", body: "{}" }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.doesNotMatch(messages[0].record.url, /request-secret|123456/);
  assert.doesNotMatch(messages[0].record.pageUrl, /page-secret/);
  assert.doesNotMatch(messages[0].record.route, /route-secret/);
  assert.match(messages[0].record.url, /%5BREDACTED%5D/);
});

test("a native response during an in-flight fallback does not leave the source locked", async () => {
  const { context, messages, intervalCallbacks, advanceTime, setFetchHandler } = makeContext();
  const url = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  await context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let releaseFallback;
  let handlerCalls = 0;
  setFetchHandler(() => {
    handlerCalls += 1;
    if (handlerCalls === 1) return new Promise((resolve) => { releaseFallback = resolve; });
    return Promise.resolve(new Response(JSON.stringify({ success: true, version: handlerCalls }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
  });
  advanceTime(5000);
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFallback(new Response("{\"success\":true,\"version\":0}", { status: 200, headers: { "content-type": "application/json" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 1);
  assert.equal(handlerCalls, 3);
});

test("native authentication failure removes an existing poller", async () => {
  const { context, messages, intervalCallbacks, advanceTime, setFetchStatus } = makeContext();
  const url = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  await context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  setFetchStatus(403);
  await context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  setFetchStatus(200);
  advanceTime(5000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 0);
});

test("XHR fallback applies a bounded timeout when the platform request has none", async () => {
  const { context, xhrInstances, intervalCallbacks, advanceTime } = makeContext();
  const request = new context.XMLHttpRequest();
  request.open("POST", "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection", true);
  request.timeout = 0;
  request.send("{}");
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(xhrInstances[1].timeout, 15000);
});

test("polling rejects unapproved origins and freezes mutable URL inputs", async () => {
  const { context, messages, fetchCalls, intervalCallbacks, advanceTime } = makeContext();
  const path = "/api/alarm-service/alarm/center/technology/detection";
  await context.fetch(`https://unapproved.example${path}`, { method: "POST", body: "{}" });
  const mutableUrl = new URL(`https://zuul-2k1v.hnznjg.cn:7443${path}`);
  await context.fetch(mutableUrl, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  mutableUrl.pathname = "/api/alarm-service/alarm/center/sendText";
  advanceTime(5000);
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 1);
  assert.equal(fetchCalls[2][0], `https://zuul-2k1v.hnznjg.cn:7443${path}`);
});

test("mutable non-string request bodies are never registered for replay", async () => {
  const { context, messages, intervalCallbacks, advanceTime } = makeContext();
  const url = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  await context.fetch(url, { method: "POST", body: new URLSearchParams({ pageNum: "1" }) });
  const form = new FormData();
  form.set("pageNum", "2");
  await context.fetch(url, { method: "POST", body: form });
  const xhr = new context.XMLHttpRequest();
  xhr.open("POST", url, true);
  xhr.send(new URLSearchParams({ pageNum: "3" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  advanceTime(5000);
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 0);
});

test("an unclassified alarmQueryList native request still suppresses the same endpoint", async () => {
  const { context, messages, intervalCallbacks, advanceTime, setFetchHandler } = makeContext();
  const url = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/alarmQueryList";
  context.location.hash = "#/alarm-center/alarm-verification";
  await context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  context.location.hash = "#/vehicle-monitor/real-time";
  context.document.querySelectorAll = () => [];
  advanceTime(5000);
  let releaseNative;
  setFetchHandler(() => new Promise((resolve) => { releaseNative = resolve; }));
  const nativeRequest = context.fetch(url, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 0);
  releaseNative(new Response("{\"success\":true}", { status: 200, headers: { "content-type": "application/json" } }));
  await nativeRequest;
});

test("older native responses cannot overwrite a newer request or revive after its 403", async () => {
  const url = "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/technology/detection";
  {
    const { context, fetchCalls, intervalCallbacks, advanceTime, setFetchHandler } = makeContext();
    let resolveA;
    let resolveB;
    let calls = 0;
    setFetchHandler(() => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveA = resolve; });
      if (calls === 2) return new Promise((resolve) => { resolveB = resolve; });
      return Promise.resolve(new Response("{\"version\":3}", { status: 200, headers: { "content-type": "application/json" } }));
    });
    const requestA = context.fetch(url, { method: "POST", headers: { "x-version": "A" }, body: "{}" });
    const requestB = context.fetch(url, { method: "POST", headers: { "x-version": "B" }, body: "{}" });
    resolveB(new Response("{\"version\":2}", { status: 200, headers: { "content-type": "application/json" } }));
    await requestB;
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveA(new Response("{\"version\":1}", { status: 200, headers: { "content-type": "application/json" } }));
    await requestA;
    await new Promise((resolve) => setTimeout(resolve, 0));
    advanceTime(5000);
    intervalCallbacks[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetchCalls[2][1].headers.get("x-version"), "B");
  }
  {
    const { context, messages, intervalCallbacks, advanceTime, setFetchHandler } = makeContext();
    let resolveA;
    let resolveB;
    let calls = 0;
    setFetchHandler(() => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveA = resolve; });
      if (calls === 2) return new Promise((resolve) => { resolveB = resolve; });
      return Promise.resolve(new Response("{\"version\":3}", { status: 200, headers: { "content-type": "application/json" } }));
    });
    const requestA = context.fetch(url, { method: "POST", body: "{\"pageNum\":1}" });
    const requestB = context.fetch(url, { method: "POST", body: "{\"pageNum\":2}" });
    resolveB(new Response("{\"error\":\"expired\"}", { status: 403, headers: { "content-type": "application/json" } }));
    await requestB;
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveA(new Response("{\"version\":1}", { status: 200, headers: { "content-type": "application/json" } }));
    await requestA;
    await new Promise((resolve) => setTimeout(resolve, 0));
    advanceTime(5000);
    intervalCallbacks[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(messages.filter((message) => message.source === "hn-alarm-realtime-poll").length, 0);
    assert.equal(calls, 2);
  }
});
