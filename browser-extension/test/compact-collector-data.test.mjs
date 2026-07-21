import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compactCollectorDirectory } from "../compact-collector-data.mjs";
import { decryptJsonLine, encryptJsonLine } from "../collector-server.mjs";

test("event snapshots compact to latest record and bounded provenance", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-collector-compact-"));
  const key = Buffer.alloc(32, 6);
  const captures = Array.from({ length: 40 }, (_, index) => `capture-${index}`);
  const sourceEntries = captures.map((captureId, index) => ({ captureId, endpoint: "realtime-alarms", capturedAt: `2026-07-19T00:${String(index).padStart(2, "0")}:00Z` }));
  const records = [
    { eventId: "alarm:one", updatedAt: "2026-07-19T00:00:00Z", sourceCaptures: ["capture-old"], sources: {} },
    { eventId: "alarm:one", updatedAt: "2026-07-19T01:00:00Z", sourceCaptures: captures, sources: { vehicleNo: sourceEntries } },
    { eventId: "alarm:two", updatedAt: "2026-07-19T02:00:00Z", sourceCaptures: ["capture-two"], sources: {} },
  ];
  const filePath = path.join(dataDir, "alarm-events-2026-07-19.encjsonl");
  await writeFile(filePath, `${records.map((record) => encryptJsonLine(record, key)).join("\n")}\n`, "utf8");
  const [result] = await compactCollectorDirectory(dataDir, key);
  assert.equal(result.inputRecords, 3);
  assert.equal(result.outputRecords, 2);
  const compacted = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => decryptJsonLine(line, key));
  assert.equal(compacted[0].sourceCaptureCount, 40);
  assert.equal(compacted[0].sourceCaptures.length, 20);
  assert.equal(compacted[0].sources.vehicleNo.length, 1);
  assert.equal(compacted[0].sources.vehicleNo[0].occurrences, 40);
});
