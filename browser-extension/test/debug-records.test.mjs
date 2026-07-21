import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const code = await readFile(new URL("../debug-records.js", import.meta.url), "utf8");
const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(code, context);

test("最近抓取记录按新到旧展示并可查看完整 JSON", () => {
  const store = context.HnCollectorDebug.createStore(2);
  store.add({ captureId: "1", matchedRule: "alarm-types", response: { body: { total: 39 } } });
  store.add({ captureId: "2", matchedRule: "realtime-alarms", response: { body: { total: 1 } } });
  store.add({ captureId: "3", matchedRule: "alarm-query", response: { body: { total: 58 } } });

  assert.deepEqual(Array.from(store.list(), (record) => record.captureId), ["3", "2"]);
  assert.match(context.HnCollectorDebug.formatRecord(store.get("3")), /"total": 58/);
});
