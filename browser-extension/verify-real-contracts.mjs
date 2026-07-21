import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { decryptJsonLine, parseCollectorDataKey } from "./collector-server.mjs";
import { extractAlarmCandidates, mergeAlarmEvents, normalizeAlarmRow } from "./alarm-domain.js";

const REQUIRED_FIELDS = ["alarmId", "alarmName", "alarmTime", "vehicleNo", "companyId", "companyName", "location"];

export async function verifyRealContracts(dataDir, dataKey) {
  const names = (await readdir(dataDir)).filter((name) => /^captures-\d{4}-\d{2}-\d{2}\.encjsonl$/.test(name)).sort();
  const events = new Map();
  const result = {
    schemaVersion: 1,
    classification: "SANITIZED_REAL_CONTRACT_VERIFICATION",
    generatedAt: new Date().toISOString(),
    captureFiles: names.length,
    captures: 0,
    candidateRows: 0,
    uniqueEvents: 0,
    rowsBySourceKind: {},
    eventsByPrimarySourceKind: {},
    weakIdentityRows: 0,
    missingFields: Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, 0])),
    missingFieldsBySource: {},
    finalMissingFields: Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, 0])),
    eventsWithConflicts: 0,
    conflictFields: {},
    maxEventBytes: 0,
  };
  for (const name of names) {
    const input = createReadStream(path.join(dataDir, name), { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const capture = decryptJsonLine(line, dataKey);
      result.captures += 1;
      for (const row of extractAlarmCandidates(capture)) {
        result.candidateRows += 1;
        const event = normalizeAlarmRow(row, capture);
        result.rowsBySourceKind[event.sourceKind] = (result.rowsBySourceKind[event.sourceKind] || 0) + 1;
        result.missingFieldsBySource[event.sourceKind] ||= Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, 0]));
        if (event.identityWeak) result.weakIdentityRows += 1;
        for (const field of REQUIRED_FIELDS) {
          if (event[field] === null || event[field] === undefined || event[field] === "") {
            result.missingFields[field] += 1;
            result.missingFieldsBySource[event.sourceKind][field] += 1;
          }
        }
        events.set(event.eventId, mergeAlarmEvents(events.get(event.eventId), event));
      }
    }
  }
  result.uniqueEvents = events.size;
  for (const event of events.values()) {
    result.eventsByPrimarySourceKind[event.sourceKind] = (result.eventsByPrimarySourceKind[event.sourceKind] || 0) + 1;
    const conflicts = Object.keys(event.conflicts || {});
    if (conflicts.length) result.eventsWithConflicts += 1;
    for (const field of conflicts) result.conflictFields[field] = (result.conflictFields[field] || 0) + 1;
    for (const field of REQUIRED_FIELDS) if (event[field] === null || event[field] === undefined || event[field] === "") result.finalMissingFields[field] += 1;
    result.maxEventBytes = Math.max(result.maxEventBytes, Buffer.byteLength(JSON.stringify(event), "utf8"));
  }
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const dataDir = path.resolve(process.env.DATA_DIR || "collector-data");
  const outputPath = path.resolve(process.env.OUTPUT_PATH || "real-contract-verification.local.json");
  const dataKey = parseCollectorDataKey(process.env.COLLECTOR_DATA_KEY);
  if (!dataKey) throw new Error("COLLECTOR_DATA_KEY is required");
  const result = await verifyRealContracts(dataDir, dataKey);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, outputPath, captures: result.captures, rows: result.candidateRows, events: result.uniqueEvents }));
}
