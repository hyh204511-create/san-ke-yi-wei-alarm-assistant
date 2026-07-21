import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../authorized-keepalive.js", import.meta.url), "utf8");

function loadAdapter() {
  const context = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.HnAuthorizedKeepalive;
}

function button(label = "查询") {
  return {
    disabled: false, textContent: label, clicked: 0,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 80, height: 30 }),
    click() { this.clicked += 1; },
  };
}

function documentWith({ buttons = [], challenge = false, login = false } = {}) {
  return {
    querySelector(selector) { return login && selector.includes("password") ? {} : null; },
    querySelectorAll(selector) {
      if (selector.startsWith("button")) return buttons;
      if (challenge && selector.includes("captcha")) return [button("验证码")];
      return [];
    },
  };
}

test("批准路由中唯一查询按钮只点击一次", () => {
  const target = button();
  const result = loadAdapter().execute({ document: documentWith({ buttons: [target] }), location: { hostname: "hn.hnznjg.cn", hash: "#/alarm-center/alarm-preprocessing" } });
  assert.equal(result.code, "SUCCESS");
  assert.equal(target.clicked, 1);
});

test("其他路由、重复按钮和挑战均安全跳过", () => {
  const adapter = loadAdapter();
  const target = button();
  assert.equal(adapter.execute({ document: documentWith({ buttons: [target] }), location: { hostname: "hn.hnznjg.cn", hash: "#/vehicle-monitor/real-time" } }).code, "SUCCESS");
  assert.equal(target.clicked, 0);
  assert.equal(adapter.execute({ document: documentWith({ buttons: [target] }), location: { hostname: "hn.hnznjg.cn", hash: "#/alarm-center/pr-alarm-recorde" } }).code, "SUCCESS");
  assert.equal(adapter.execute({ document: documentWith({ buttons: [button(), button()] }), location: { hostname: "hn.hnznjg.cn", hash: "#/alarm-center/alarm-preprocessing" } }).code, "TARGET_AMBIGUOUS");
  assert.equal(adapter.execute({ document: documentWith({ buttons: [button()], challenge: true }), location: { hostname: "hn.hnznjg.cn", hash: "#/alarm-center/alarm-preprocessing" } }).code, "CHALLENGE_DETECTED");
  assert.equal(target.clicked, 0);
});
