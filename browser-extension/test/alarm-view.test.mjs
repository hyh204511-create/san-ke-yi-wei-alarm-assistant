import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const viewCode = await readFile(new URL("../alarm-view.js", import.meta.url), "utf8");

function loadView() {
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(viewCode, context);
  return context.HnAlarmView;
}

function item(sourceKind, eventId) {
  return { event: { eventId, sourceKind } };
}

test("正式报警展示组只包含 REALTIME 和 PENDING", () => {
  const view = loadView();
  const events = [
    item("REALTIME", "realtime"),
    item("PENDING", "pending"),
    item("TECHNICAL", "technical"),
    item("PREWARNING", "prewarning"),
    item("HISTORY", "history")
  ];

  assert.deepEqual({ ...view.countsFor(events) }, { FORMAL: 2, TECHNICAL: 1, PREWARNING: 1 });
  assert.deepEqual(Array.from(view.filterEvents(events, "FORMAL"), (entry) => entry.event.eventId), ["realtime", "pending"]);
  assert.deepEqual(Array.from(view.filterEvents(events, "priority"), (entry) => entry.event.eventId), ["realtime", "pending", "technical"]);
  assert.deepEqual(Array.from(view.filterEvents(events, "all"), (entry) => entry.event.eventId), ["realtime", "pending", "technical", "prewarning", "history"]);
  assert.equal(view.displaySourceLabel(events[0].event), "正式报警");
  assert.equal(view.displaySourceLabel({ ...events[3].event, sourceLabel: "预警" }), "预警");
});
