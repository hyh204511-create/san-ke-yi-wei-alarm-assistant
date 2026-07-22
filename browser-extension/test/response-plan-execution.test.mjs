import test from "node:test";
import assert from "node:assert/strict";

import { executeVoiceThenTextFallback } from "../response-plan-execution.js";

const ordered = [
  { channelType: "VOICE", order: 1 },
  { channelType: "TEXT", order: 2 },
];

async function run(statuses) {
  const called = [];
  const outcome = await executeVoiceThenTextFallback(ordered, {
    execute: async (attempt) => {
      called.push(attempt.channelType);
      return { ...attempt, status: statuses[attempt.channelType] };
    },
    skip: async (attempt, reason) => ({ ...attempt, status: "SKIPPED", reason }),
  });
  return { ...outcome, called };
}

test("语音和文本均成功时严格顺序完成", async () => {
  const result = await run({ VOICE: "SUCCEEDED", TEXT: "SUCCEEDED" });
  assert.deepEqual(result.called, ["VOICE", "TEXT"]);
  assert.equal(result.failed, false);
  assert.equal(result.fallbackUsed, false);
});

test("语音明确失败时仍发送文本但保留人工关注", async () => {
  const result = await run({ VOICE: "FAILED", TEXT: "SUCCEEDED" });
  assert.deepEqual(result.called, ["VOICE", "TEXT"]);
  assert.equal(result.failed, true);
  assert.equal(result.fallbackUsed, true);
});

test("语音结果未知或被阻断时禁止发送文本", async () => {
  for (const status of ["UNKNOWN", "BLOCKED"]) {
    const result = await run({ VOICE: status, TEXT: "SUCCEEDED" });
    assert.deepEqual(result.called, ["VOICE"]);
    assert.equal(result.attempts[1].status, "SKIPPED");
    assert.equal(result.failed, true);
    assert.equal(result.fallbackUsed, false);
  }
});
