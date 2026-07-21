import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptJsonLine } from "../collector-server.mjs";
import { verifyRealContracts } from "../verify-real-contracts.mjs";

test("real contract verifier returns aggregate coverage without business values", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-real-verify-"));
  const key = Buffer.alloc(32, 8);
  const capture = {
    captureId: "secret-capture", capturedAt: "2026-07-19T01:00:00Z", matchedRule: "realtime-alarms",
    response: { body: { data: [{ id: "9000000000000000001", alarmName: "secret-alarm", alarmTime: "2026-07-19 09:00:00", certId: "SECRET-PLATE", companyId: "SECRET-COMPANY", companyName: "SECRET-NAME", location: "SECRET-LOCATION" }] } },
  };
  await writeFile(path.join(dataDir, "captures-2026-07-19.encjsonl"), `${encryptJsonLine(capture, key)}\n`, "utf8");
  const result = await verifyRealContracts(dataDir, key);
  const output = JSON.stringify(result);
  assert.equal(result.candidateRows, 1);
  assert.equal(result.uniqueEvents, 1);
  assert.equal(result.weakIdentityRows, 0);
  assert.equal(result.rowsBySourceKind.REALTIME, 1);
  assert.doesNotMatch(output, /SECRET|9000000000000000001|secret-alarm/);
});
