import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptJsonLine } from "../collector-server.mjs";
import { analyzeCollectorContracts } from "../analyze-collector-contracts.mjs";

test("contract analyzer emits field shapes without sensitive values", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-contracts-"));
  const key = Buffer.alloc(32, 4);
  const capture = {
    captureId: "capture-secret", capturedAt: "2026-07-19T01:00:00Z", matchedRule: "realtime-alarms",
    method: "POST", url: "https://example.test/api/realtime?page=1", route: "#/alarm-center/alarm-preprocessing?vehicle=secret", status: 200, isAlarm: true,
    request: { body: { pageNum: 1 } },
    response: { body: { success: true, data: { rows: [{ alarmId: "9000000000000000001", vehicleNo: "TEST-SECRET" }] } } },
  };
  await writeFile(path.join(dataDir, "captures-2026-07-19.encjsonl"), `${encryptJsonLine(capture, key)}\n`, "utf8");
  const summary = await analyzeCollectorContracts(dataDir, key);
  const output = JSON.stringify(summary);
  assert.equal(summary.captureCount, 1);
  assert.equal(summary.contracts[0].endpointPath, "/api/realtime");
  assert.deepEqual(summary.contracts[0].routes, { "#/alarm-center/alarm-preprocessing": 1 });
  assert.deepEqual(summary.contracts[0].responseShape["response.data.rows[].vehicleNo"], ["string"]);
  assert.doesNotMatch(output, /TEST-SECRET|9000000000000000001|capture-secret/);
});

test("contract analyzer normalizes sensitive dynamic identifiers", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-contract-identifiers-"));
  const key = Buffer.alloc(32, 5);
  const capture = {
    capturedAt: "2026-07-19T01:00:00Z", matchedRule: "vehicle-info", method: "GET",
    url: "https://example.test/api/vehicle/getMonitorCarInfo/1195586082209550336", status: 200,
    response: { body: { data: { "1195586082209550336": { vehicleNo: "SECRET" } } } },
  };
  await writeFile(path.join(dataDir, "captures-2026-07-19.encjsonl"), `${encryptJsonLine(capture, key)}\n`, "utf8");
  const summary = await analyzeCollectorContracts(dataDir, key);
  const output = JSON.stringify(summary);
  assert.equal(summary.contracts[0].endpointPath, "/api/vehicle/getMonitorCarInfo/:id");
  assert.match(output, /\{dynamicKey\}/);
  assert.doesNotMatch(output, /1195586082209550336|SECRET/);
});
