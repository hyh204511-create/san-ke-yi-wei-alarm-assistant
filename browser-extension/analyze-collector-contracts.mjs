import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { decryptJsonLine, parseCollectorDataKey } from "./collector-server.mjs";
import { extractAlarmCandidates } from "./alarm-domain.js";

const SAFE_ENUM_FIELDS = [
  "alarmCompleteStatus", "alarmCompleteStatusName", "alarmStatus", "alarmStatusName", "statusName",
  "dealFlag", "dispositionFlag", "ignoreStatus", "verificationStatus", "appealResult",
  "positiveReportingFLag", "evidenceAuditStatus", "driverAppealProgress"
];

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function collectShape(value, prefix, shape, depth = 0) {
  const type = valueType(value);
  const key = prefix || "$";
  if (!shape[key]) shape[key] = new Set();
  shape[key].add(type);
  if (depth >= 7) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectShape(item, `${key}[]`, shape, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [field, item] of Object.entries(value)) {
      const safeField = /^\d{8,}$/.test(field) || /^[0-9a-f-]{24,}$/i.test(field) ? "{dynamicKey}" : field;
      collectShape(item, prefix ? `${prefix}.${safeField}` : safeField, shape, depth + 1);
    }
  }
}

function safePath(urlValue) {
  try {
    const parsed = new URL(String(urlValue));
    return parsed.pathname.replace(/\/\d{8,}(?=\/|$)/g, "/:id");
  } catch {
    return String(urlValue || "").split("?")[0].slice(0, 500).replace(/\/\d{8,}(?=\/|$)/g, "/:id");
  }
}

function safeRoute(routeValue) {
  return String(routeValue || "").split("?")[0].slice(0, 300).replace(/\d{8,}/g, ":id");
}

function finalizeShape(shape) {
  return Object.fromEntries(Object.entries(shape).sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, [...values].sort()]));
}

export async function analyzeCollectorContracts(dataDir, dataKey) {
  const names = (await readdir(dataDir)).filter((name) => /^captures-\d{4}-\d{2}-\d{2}\.encjsonl$/.test(name)).sort();
  const contracts = new Map();
  let captureCount = 0;
  for (const name of names) {
    const input = createReadStream(path.join(dataDir, name), { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const capture = decryptJsonLine(line, dataKey);
      captureCount += 1;
      const endpointPath = safePath(capture.url || capture.request?.url || capture.endpoint);
      const rule = String(capture.matchedRule || "unmatched");
      const key = `${rule}|${capture.method || "UNKNOWN"}|${endpointPath}`;
      if (!contracts.has(key)) contracts.set(key, {
        matchedRule: rule,
        method: String(capture.method || "UNKNOWN"),
        endpointPath,
        count: 0,
        alarmCaptureCount: 0,
        extractedAlarmRows: 0,
        statuses: {},
        routes: {},
        firstCapturedAt: null,
        lastCapturedAt: null,
        requestShape: {},
        responseShape: {},
        enumValues: {},
      });
      const contract = contracts.get(key);
      contract.count += 1;
      if (capture.isAlarm) contract.alarmCaptureCount += 1;
      const alarmRows = extractAlarmCandidates(capture);
      contract.extractedAlarmRows += alarmRows.length;
      for (const row of alarmRows) {
        for (const field of SAFE_ENUM_FIELDS) {
          const value = row?.[field];
          if (value === undefined || value === null || typeof value === "object") continue;
          const normalized = String(value).slice(0, 100);
          contract.enumValues[field] ||= {};
          contract.enumValues[field][normalized] = (contract.enumValues[field][normalized] || 0) + 1;
        }
      }
      const status = String(capture.status ?? "unknown");
      contract.statuses[status] = (contract.statuses[status] || 0) + 1;
      const route = safeRoute(capture.route);
      if (route) contract.routes[route] = (contract.routes[route] || 0) + 1;
      const capturedAt = String(capture.capturedAt || "");
      if (capturedAt && (!contract.firstCapturedAt || capturedAt < contract.firstCapturedAt)) contract.firstCapturedAt = capturedAt;
      if (capturedAt && (!contract.lastCapturedAt || capturedAt > contract.lastCapturedAt)) contract.lastCapturedAt = capturedAt;
      collectShape(capture.request?.body ?? capture.requestBody, "request", contract.requestShape);
      collectShape(capture.response?.body ?? capture.responseBody, "response", contract.responseShape);
    }
  }
  return {
    schemaVersion: 1,
    classification: "SANITIZED_CONTRACT_METADATA",
    generatedAt: new Date().toISOString(),
    captureFiles: names.length,
    captureCount,
    contracts: [...contracts.values()].map((contract) => ({
      ...contract,
      statuses: Object.fromEntries(Object.entries(contract.statuses).sort(([left], [right]) => left.localeCompare(right))),
      routes: Object.fromEntries(Object.entries(contract.routes).sort(([, left], [, right]) => right - left)),
      requestShape: finalizeShape(contract.requestShape),
      responseShape: finalizeShape(contract.responseShape),
      enumValues: Object.fromEntries(Object.entries(contract.enumValues).sort(([left], [right]) => left.localeCompare(right)).map(([field, values]) => [field, Object.fromEntries(Object.entries(values).sort(([, left], [, right]) => right - left))])),
    })).sort((left, right) => right.count - left.count || left.matchedRule.localeCompare(right.matchedRule)),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const dataDir = path.resolve(process.env.DATA_DIR || "collector-data");
  const outputPath = path.resolve(process.env.OUTPUT_PATH || "contract-summary.local.json");
  const dataKey = parseCollectorDataKey(process.env.COLLECTOR_DATA_KEY);
  if (!dataKey) throw new Error("COLLECTOR_DATA_KEY is required");
  const summary = await analyzeCollectorContracts(dataDir, dataKey);
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, outputPath, captures: summary.captureCount, contracts: summary.contracts.length }));
}
