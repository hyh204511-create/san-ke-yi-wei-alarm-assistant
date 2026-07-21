import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { createResponsePlan, evaluateRules } from "../alarm-domain.js";

test("捕获响应在快速路径完成后立即返回，后台同步和动作不阻塞界面", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const handler = worker.slice(worker.indexOf('if (message.type === "CAPTURE")'), worker.indexOf('if (message.type === "STATUS")'));
  assert.match(handler, /processCaptureFast/);
  assert.match(handler, /void completeCaptureInBackground/);
  assert.doesNotMatch(handler, /await completeCaptureInBackground/);
  assert.match(worker, /lastDecisionLatencyMs/);
  assert.match(worker, /backgroundPending/);
  assert.match(worker, /recoverInterruptedResponsePlans/);
  assert.match(worker, /动作结果未知，已停止自动重试并转人工/);
});

test("百条正式报警的本地规则决策和TEXT_TTS计划低于一秒", () => {
  const template = "驾驶员，平台已报警，请注意安全驾驶。";
  const ruleSet = {
    schemaVersion: 2,
    version: "performance-v1",
    status: "PUBLISHED",
    rules: [{
      id: "generic-formal-alarm",
      enabled: true,
      priority: 1,
      match: { sourceKinds: ["REALTIME", "TECHNICAL", "PENDING"] },
      handlingMode: "AUTO",
      channels: [
        { type: "TEXT", order: 1, templateId: "text-generic", recipientType: "DRIVER_TERMINAL", terminalTts: true },
      ],
      channelStrategy: "SINGLE",
      retryPolicy: { maxRetries: 2, delaysMs: [5000, 10000], retryOn: ["FAILED"], maxDurationMs: 30000 },
      fallback: "MANUAL",
    }],
  };
  const assets = {
    "text-generic": { assetKey: "text-generic", version: "v1", channelType: "TEXT", textTemplate: template, contentHash: "0".repeat(64) },
  };
  const started = performance.now();
  for (let index = 0; index < 100; index += 1) {
    const event = { eventId: `event-${index}`, alarmId: String(index), sourceKind: "REALTIME", alarmName: "模拟正式报警", vehicleId: `vehicle-${index}` };
    const decision = evaluateRules(event, ruleSet);
    const plan = createResponsePlan(event, decision, { mode: "SANDBOX" }, assets);
    assert.equal(plan.status, "PLANNED");
  }
  assert.ok(performance.now() - started < 1000);
});
