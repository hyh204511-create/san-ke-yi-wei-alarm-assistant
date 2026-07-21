import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCollectorServer, decryptJsonLine, extractAlarmRows } from "../collector-server.mjs";

const TEST_DATA_KEY = Buffer.alloc(32, 7);

function readEncryptedRecord(content) {
  return decryptJsonLine(content.trim(), TEST_DATA_KEY);
}

test("alarm type dictionaries are not treated as alarm events", () => {
  assert.deepEqual(extractAlarmRows({
    matchedRule: "alarm-types",
    isAlarm: true,
    response: { body: { data: [{ alarmId: "62", alarmName: "smoke alarm" }] } }
  }), []);
});

test("collector encrypts captures and extracted alarm rows at rest", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-alarm-collector-"));
  const { server } = createCollectorServer({ dataDir, dataKey: TEST_DATA_KEY });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const capture = {
    captureId: "capture-test-1",
    capturedAt: "2026-07-17T01:02:03.000Z",
    matchedRule: "realtime-alarms",
    isAlarm: true,
    response: { body: { success: true, data: [{ id: "alarm-1", alarmId: "62", alarmName: "smoke alarm", certId: "TEST-01" }] } }
  };

  const response = await fetch(`http://127.0.0.1:${port}/captures`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(capture)
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, alarmRows: 1 });

  const raw = await readFile(path.join(dataDir, "captures-2026-07-17.encjsonl"), "utf8");
  const alarms = await readFile(path.join(dataDir, "alarms-2026-07-17.encjsonl"), "utf8");
  assert.match(raw, /^enc:v1:/);
  assert.doesNotMatch(raw, /capture-test-1|TEST-01/);
  assert.equal(readEncryptedRecord(raw).captureId, "capture-test-1");
  assert.equal(readEncryptedRecord(alarms).record.alarmName, "smoke alarm");

  const retry = await fetch(`http://127.0.0.1:${port}/captures`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(capture)
  });
  assert.deepEqual(await retry.json(), { ok: true, duplicate: true, alarmRows: 0 });
  assert.equal((await readFile(path.join(dataDir, "captures-2026-07-17.encjsonl"), "utf8")).trim().split("\n").length, 1);
});

test("collector refuses persistence when the encryption key is missing", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-alarm-no-key-"));
  const { server } = createCollectorServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status, 503);
  const response = await fetch(`http://127.0.0.1:${port}/records`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "event", record: { eventId: "alarm:no-key" } })
  });
  assert.equal(response.status, 503);
});

test("collector decrypts ledger internally and only exports masked CSV", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-alarm-ledger-"));
  const { server } = createCollectorServer({ dataDir, dataKey: TEST_DATA_KEY });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const event = { eventId: "alarm:test", alarmId: "9000000000000000001", updatedAt: "2026-07-18T01:02:03.000Z" };
  const ledger = { auditId: "ledger:alarm:test", eventId: "alarm:test", alarmId: "9000000000000000001", treatment: "MANUAL_REVIEW", updatedAt: "2026-07-18T01:02:04.000Z" };
  for (const body of [{ kind: "event", record: event }, { kind: "ledger", record: ledger }]) {
    const response = await fetch(`http://127.0.0.1:${port}/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 201);
  }
  const updatedLedger = { ...ledger, treatment: "RECORD_ONLY", updatedAt: "2026-07-18T01:02:05.000Z" };
  const updateResponse = await fetch(`http://127.0.0.1:${port}/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "ledger", record: updatedLedger }) });
  assert.equal(updateResponse.status, 201);
  assert.equal(readEncryptedRecord(await readFile(path.join(dataDir, "alarm-events-2026-07-18.encjsonl"), "utf8")).alarmId, "9000000000000000001");
  const csvResponse = await fetch(`http://127.0.0.1:${port}/ledger?format=csv`);
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.match(csv, /900000\*\*\*\*0001/);
  assert.doesNotMatch(csv, /MANUAL_REVIEW/);
  assert.match(csv, /RECORD_ONLY/);
  assert.equal(csv.trim().split("\r\n").length, 2);
  const jsonResponse = await fetch(`http://127.0.0.1:${port}/ledger?format=json`);
  assert.equal(jsonResponse.status, 403);
});
