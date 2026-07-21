import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { decryptJsonLine, encryptJsonLine, parseCollectorDataKey } from "./collector-server.mjs";

const COMPACTABLE_NAME = /^(alarm-events|ledger)-\d{4}-\d{2}-\d{2}\.encjsonl$/;
const MAX_RECENT_CAPTURE_REFS = 20;

function compactSourceEntries(entries) {
  const byEndpoint = new Map();
  for (const item of Array.isArray(entries) ? entries : []) {
    const key = item?.endpoint || item?.captureId || "unknown";
    const current = byEndpoint.get(key);
    if (!current) {
      byEndpoint.set(key, {
        ...item,
        firstCaptureId: item?.firstCaptureId || item?.captureId || null,
        firstCapturedAt: item?.firstCapturedAt || item?.capturedAt || null,
        lastCaptureId: item?.lastCaptureId || item?.captureId || null,
        lastCapturedAt: item?.lastCapturedAt || item?.capturedAt || null,
        occurrences: Number(item?.occurrences || 1),
      });
      continue;
    }
    const firstAt = item?.firstCapturedAt || item?.capturedAt;
    const lastAt = item?.lastCapturedAt || item?.capturedAt;
    if (firstAt && (!current.firstCapturedAt || firstAt < current.firstCapturedAt)) {
      current.firstCapturedAt = firstAt;
      current.firstCaptureId = item?.firstCaptureId || item?.captureId || null;
    }
    if (lastAt && (!current.lastCapturedAt || lastAt >= current.lastCapturedAt)) {
      current.lastCapturedAt = lastAt;
      current.lastCaptureId = item?.lastCaptureId || item?.captureId || null;
      current.captureId = current.lastCaptureId;
      current.capturedAt = lastAt;
    }
    current.occurrences += Number(item?.occurrences || 1);
  }
  return [...byEndpoint.values()];
}

export function compactEventRecord(record) {
  const sourceCaptures = Array.isArray(record?.sourceCaptures) ? record.sourceCaptures : [];
  const sources = Object.fromEntries(Object.entries(record?.sources || {}).map(([field, entries]) => [field, compactSourceEntries(entries)]));
  return {
    ...record,
    sourceCaptureCount: Math.max(Number(record?.sourceCaptureCount || 0), sourceCaptures.length),
    sourceCaptures: sourceCaptures.slice(-MAX_RECENT_CAPTURE_REFS),
    sources,
  };
}

async function writeEncryptedRecords(filePath, records, dataKey) {
  const output = createWriteStream(filePath, { encoding: "utf8", flags: "wx" });
  for (const record of records) {
    if (!output.write(`${encryptJsonLine(record, dataKey)}\n`, "utf8")) await once(output, "drain");
  }
  output.end();
  await once(output, "close");
}

export async function compactCollectorFile(filePath, dataKey) {
  const source = path.resolve(filePath);
  const name = path.basename(source);
  if (!COMPACTABLE_NAME.test(name)) throw new Error(`Unsupported compactable file: ${source}`);
  const beforeBytes = (await stat(source)).size;
  const latestByKey = new Map();
  const input = createReadStream(source, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let inputRecords = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = decryptJsonLine(line, dataKey);
    inputRecords += 1;
    const recordKey = record.eventId || record.auditId || record.alarmId;
    if (!recordKey) continue;
    const current = latestByKey.get(recordKey);
    if (!current || String(record.updatedAt || "") >= String(current.updatedAt || "")) latestByKey.set(recordKey, record);
  }
  const records = [...latestByKey.values()]
    .map((record) => name.startsWith("alarm-events-") ? compactEventRecord(record) : record)
    .sort((left, right) => String(left.eventId || left.auditId).localeCompare(String(right.eventId || right.auditId)));
  const temporary = `${source}.compact.tmp`;
  const backup = `${source}.precompact`;
  try {
    await writeEncryptedRecords(temporary, records, dataKey);
    await rename(source, backup);
    await rename(temporary, source);
    await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  const afterBytes = (await stat(source)).size;
  return { file: name, inputRecords, outputRecords: records.length, beforeBytes, afterBytes };
}

export async function compactCollectorDirectory(dataDir, dataKey) {
  const directory = path.resolve(dataDir);
  const names = (await readdir(directory)).filter((name) => COMPACTABLE_NAME.test(name)).sort();
  const results = [];
  for (const name of names) results.push(await compactCollectorFile(path.join(directory, name), dataKey));
  return results;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const dataDir = path.resolve(process.env.DATA_DIR || "collector-data");
  const dataKey = parseCollectorDataKey(process.env.COLLECTOR_DATA_KEY);
  if (!dataKey) throw new Error("COLLECTOR_DATA_KEY is required");
  const results = await compactCollectorDirectory(dataDir, dataKey);
  console.log(JSON.stringify({ ok: true, results }));
}
