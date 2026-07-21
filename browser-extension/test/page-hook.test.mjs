import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const hookCode = await readFile(new URL("../page-hook.js", import.meta.url), "utf8");

function makeContext() {
  const messages = [];
  const intervalCallbacks = [];
  let fetchVersion = 1;
  class FakeXHR {
    constructor() {
      this.listeners = {};
      this.status = 200;
      this.responseType = "";
      this.responseText = JSON.stringify({
        success: true,
        data: [{ id: "a-2", alarmId: "99", alarmName: "未系安全带" }]
      });
    }
    open(method, url) {
      this.nativeOpen = { method, url };
    }
    setRequestHeader() {}
    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }
    getResponseHeader(name) {
      return name === "content-type" ? "application/json" : null;
    }
    send() {
      queueMicrotask(() => this.listeners.loadend?.call(this));
    }
  }

  const context = {
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    FormData,
    XMLHttpRequest: FakeXHR,
    crypto: webcrypto,
    location: {
      href: "https://hn.hnznjg.cn:7443/#/board-center",
      hash: "#/board-center",
      origin: "https://hn.hnznjg.cn:7443"
    },
    document: { visibilityState: "visible" },
    performance: { now: () => Date.now() },
    fetch: async () => new Response(JSON.stringify({
      success: true,
      data: [{ id: `a-${fetchVersion}`, alarmId: String(61 + fetchVersion), alarmName: "抽烟报警", ownerPhone: "synthetic-phone-value" }]
    }), { status: 200, headers: { "content-type": "application/json" } }),
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
  return { context, messages, intervalCallbacks, setFetchVersion: (value) => { fetchVersion = value; } };
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

test("实时监控页按三秒兜底轮询且相同响应不重复入库", async () => {
  const { context, messages, intervalCallbacks } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";

  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: JSON.stringify({ pageNum: 1 }) }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(intervalCallbacks.length, 1);
  assert.equal(intervalCallbacks[0].delay, 3000);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.length, 2);
  assert.equal(messages[1].source, "hn-alarm-realtime-poll");
  assert.equal(messages[1].status, 200);
  assert.equal(messages[1].changed, false);
});

test("离开实时监控页时秒级轮询安全跳过", async () => {
  const { context, messages, intervalCallbacks } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: "{}" }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  context.location.hash = "#/alarm-center/alarm-recorde";
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, 1);
});

test("实时轮询响应变化时立即产生新的抓取记录", async () => {
  const { context, messages, intervalCallbacks, setFetchVersion } = makeContext();
  context.location.hash = "#/vehicle-monitor/real-time";
  await context.fetch(
    "https://zuul-2k1v.hnznjg.cn:7443/api/alarm-service/alarm/center/getVideoUnprocessedAlarm",
    { method: "POST", body: "{}" }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  setFetchVersion(2);
  await intervalCallbacks[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, 3);
  assert.equal(messages[1].source, "hn-alarm-realtime-poll");
  assert.equal(messages[1].changed, true);
  assert.equal(messages[2].record.transport, "fetch-poll");
  assert.equal(messages[2].record.response.body.data[0].alarmId, "63");
});
