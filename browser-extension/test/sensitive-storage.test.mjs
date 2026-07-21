import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("sensitive browser cache is bounded and raw captures are never queued locally", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const MAX_EVENTS = 200/);
  assert.match(worker, /const MAX_OUTBOX = 200/);
  assert.match(worker, /SENSITIVE_CACHE_RETENTION_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(worker, /persistCaptureWithoutLocalQueue/);
  assert.match(worker, /Never place them in browser storage/);
  assert.match(worker, /pruneSensitiveCache/);
});
