import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const code = await readFile(new URL("../realtime-dom.js", import.meta.url), "utf8");

function loadHelper() {
  const context = { globalThis: {} };
  vm.runInNewContext(code, context);
  return context.globalThis.HnRealtimeDom;
}

const headers = [
  "状态", "报警ID", "报警类型", "报警详情", "类型", "车牌号", "终端版本",
  "发生时间", "接收时间", "所属机构", "驾驶员", "定位速度(公里/时)",
  "脉冲速度(公里/时)", "报警地址", "证据",
];

test("extracts the active realtime table into normalized formal alarm rows", () => {
  const helper = loadHelper();
  const result = helper.extractRows(headers, [[
    "", "2080169516025012224", "驾驶员突发情况", "-", "湖南省两客车辆", "湘EH6882(黄)", "2025",
    "2026-07-23 13:53:51", "2026-07-23 13:53:54", "湖南邵阳湘运集团有限责任公司武冈分公司", "马孝城",
    "91.0", "-", "广东省阳山县许广高速", "查看证据",
  ]]);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].alarmId, "2080169516025012224");
  assert.equal(result.rows[0].certId, "湘EH6882");
  assert.equal(result.rows[0].pulseSpeed, "");
  assert.match(result.signature, /^[a-f0-9]{8}$/);
});

test("rejects unrelated tables and ignores loading placeholder rows", () => {
  const helper = loadHelper();
  assert.equal(helper.extractRows(["车牌号", "预警类型"], []).code, "REALTIME_DOM_HEADERS_MISMATCH");
  const empty = helper.extractRows(headers, [headers.map(() => "")]);
  assert.equal(empty.ok, true);
  assert.equal(empty.code, "REALTIME_DOM_EMPTY");
  assert.deepEqual(Array.from(empty.rows), []);
});

test("signature changes when a realtime row changes and stays stable for identical data", () => {
  const helper = loadHelper();
  const base = ["", "2080171595291623424", "生理疲劳", "-", "湖南省两客车辆", "湘EH9198(黄)", "2025", "2026-07-23 14:02:06", "2026-07-23 14:02:10", "某企业", "-", "90", "-", "某地址", ""];
  const first = helper.extractRows(headers, [base]);
  const same = helper.extractRows(headers, [[...base]]);
  const changed = helper.extractRows(headers, [[...base.slice(0, 11), "91", ...base.slice(12)]]);
  assert.equal(first.signature, same.signature);
  assert.notEqual(first.signature, changed.signature);
});

test("content wiring only backfills the visible active realtime table without clicking", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const isolatedScripts = manifest.content_scripts.find((entry) => entry.js.includes("content.js")).js;
  assert.ok(isolatedScripts.indexOf("realtime-dom.js") < isolatedScripts.indexOf("content.js"));
  assert.match(content, /\.base-panel\.real-time-footer/);
  assert.match(content, /\.tab-item\.active/);
  assert.match(content, /\^实时报警/);
  assert.match(content, /matchedRule:\s*"realtime-alarms"/);
  assert.match(content, /method:\s*"DOM"/);
  assert.doesNotMatch(content.match(/async function backfillVisibleRealtimeAlarms\(\)[\s\S]*?\n  }/)?.[0] || "", /\.click\(|\.dispatchEvent\(/);
});
