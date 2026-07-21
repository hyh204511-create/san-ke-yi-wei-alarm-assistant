import test from "node:test";
import assert from "node:assert/strict";

import { executeWithRetry, normalizeRetryPolicy } from "../response-retry.js";

test("明确失败按5秒和10秒最多重试两次并在30秒内升级", async () => {
  const waits = [];
  const results = [
    { status: "FAILED", error: "第一次失败" },
    { status: "FAILED", error: "第二次失败" },
    { status: "SUCCEEDED", result: { receiptId: "local-1" } },
  ];
  const output = await executeWithRetry(
    async () => results.shift(),
    null,
    { waitFn: async (delay) => waits.push(delay) },
  );
  assert.equal(output.status, "SUCCEEDED");
  assert.equal(output.retryCount, 2);
  assert.deepEqual(waits, [5_000, 10_000]);
  assert.equal(output.deliveries.length, 3);
});

test("超时结果未知立即停止且不自动重试", async () => {
  let calls = 0;
  const output = await executeWithRetry(async () => {
    calls += 1;
    return { status: "UNKNOWN", error: "请求超时，结果未知" };
  });
  assert.equal(output.status, "UNKNOWN");
  assert.equal(output.retryCount, 0);
  assert.equal(calls, 1);
});

test("非法重试配置回落到受控默认值", () => {
  assert.deepEqual(normalizeRetryPolicy({ maxRetries: 9, delaysMs: [1], retryOn: ["UNKNOWN"] }), {
    maxRetries: 2,
    delaysMs: [5_000, 10_000],
    retryOn: ["FAILED"],
    maxDurationMs: 30_000,
  });
});
