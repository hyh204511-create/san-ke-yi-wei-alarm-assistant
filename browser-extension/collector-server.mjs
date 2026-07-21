import http from "node:http";
import { mkdir, appendFile, readFile, readdir } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractAlarmCandidates, maskLedgerRow, rowsToCsv } from "./alarm-domain.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const ENCRYPTED_LINE_PREFIX = "enc:v1:";

export function parseCollectorDataKey(encoded) {
  const value = String(encoded || "").trim();
  if (!value) return null;
  const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error("COLLECTOR_DATA_KEY must decode to exactly 32 bytes");
  return key;
}

export function encryptJsonLine(value, dataKey) {
  if (!dataKey) throw new Error("COLLECTOR_DATA_KEY is required for sensitive persistence");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  cipher.setAAD(Buffer.from("alarm-collector-jsonl-v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_LINE_PREFIX}${Buffer.concat([nonce, tag, ciphertext]).toString("base64url")}`;
}

export function decryptJsonLine(line, dataKey) {
  if (!dataKey || !String(line).startsWith(ENCRYPTED_LINE_PREFIX)) throw new Error("Encrypted collector line is invalid");
  const packed = Buffer.from(String(line).slice(ENCRYPTED_LINE_PREFIX.length), "base64url");
  if (packed.length < 29) throw new Error("Encrypted collector line is truncated");
  const decipher = createDecipheriv("aes-256-gcm", dataKey, packed.subarray(0, 12));
  decipher.setAAD(Buffer.from("alarm-collector-jsonl-v1", "utf8"));
  decipher.setAuthTag(packed.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function extractAlarmRows(capture) {
  return extractAlarmCandidates(capture);
}

function datePart(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 10);
}

async function appendJsonLines(file, rows, dataKey) {
  if (!rows.length) return;
  await appendFile(file, `${rows.map((row) => encryptJsonLine(row, dataKey)).join("\n")}\n`, "utf8");
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体超过 10MB 限制");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return "http://127.0.0.1";
  if (origin.startsWith("chrome-extension://")) return origin;
  if (/^https:\/\/([a-z0-9-]+\.)*hnznjg\.cn:7443$/i.test(origin)) return origin;
  return null;
}

function json(request, response, status, body) {
  const origin = allowedOrigin(request);
  if (!origin) {
    response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    return response.end(JSON.stringify({ ok: false, error: "Origin not allowed" }));
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "vary": "origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function text(request, response, status, body, contentType) {
  const origin = allowedOrigin(request);
  if (!origin) return json(request, response, 403, { ok: false, error: "Origin not allowed" });
  response.writeHead(status, {
    "content-type": contentType,
    "content-disposition": `attachment; filename="alarm-ledger-${new Date().toISOString().slice(0, 10)}.${contentType.includes("csv") ? "csv" : "json"}"`,
    "access-control-allow-origin": origin,
    "vary": "origin",
    "cache-control": "no-store"
  });
  response.end(body);
}

const RECORD_FILES = {
  event: "alarm-events",
  decision: "decisions",
  action: "action-attempts",
  audit: "audit",
  ledger: "ledger"
};

async function readLedger(dataDir, dataKey) {
  let names = [];
  try {
    names = (await readdir(dataDir)).filter((name) => /^ledger-\d{4}-\d{2}-\d{2}\.encjsonl$/.test(name)).sort();
  } catch {
    return [];
  }
  const latestByEvent = new Map();
  for (const name of names) {
    const content = await readFile(path.join(dataDir, name), "utf8");
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try {
        const row = decryptJsonLine(line, dataKey);
        const key = row.eventId || row.auditId || row.alarmId;
        if (key) latestByEvent.set(key, row);
      } catch {}
    }
  }
  return [...latestByEvent.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export function createCollectorServer({ dataDir = path.resolve("collector-data"), dataKey = null } = {}) {
  const stats = { captures: 0, alarmRows: 0, records: 0, startedAt: new Date().toISOString() };
  // 进程内幂等用于拦截即时重试；业务事件去重由扩展持久化事件键负责。
  const seenCaptureIds = new Set();
  const seenRecordIds = new Set();
  let writeQueue = Promise.resolve();
  const serializeWrite = (task) => {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => {});
    return next;
  };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (request.method === "OPTIONS") return json(request, response, 204, {});
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return json(request, response, 200, { ok: true, persistenceEncrypted: Boolean(dataKey), ...stats });
    }
    if (request.method === "GET" && requestUrl.pathname === "/ready") {
      return json(request, response, dataKey ? 200 : 503, { ok: Boolean(dataKey), persistenceEncrypted: Boolean(dataKey) });
    }
    if (request.method === "GET" && requestUrl.pathname === "/ledger") {
      if (!dataKey) return json(request, response, 503, { ok: false, error: "COLLECTOR_DATA_KEY is required" });
      const rows = await readLedger(dataDir, dataKey);
      const format = requestUrl.searchParams.get("format") || "csv";
      if (format !== "csv") return json(request, response, 403, { ok: false, error: "完整JSON已禁用；敏感证据包流程尚未启用" });
      return text(request, response, 200, rowsToCsv(rows.map(maskLedgerRow)), "text/csv; charset=utf-8");
    }
    if (request.method === "POST" && requestUrl.pathname === "/records") {
      try {
        if (!dataKey) return json(request, response, 503, { ok: false, error: "COLLECTOR_DATA_KEY is required" });
        const body = await readJson(request);
        const prefix = RECORD_FILES[body?.kind];
        const record = body?.record;
        const recordId = record?.eventId || record?.decisionId || record?.actionId || record?.auditId || body?.recordId;
        if (!prefix || !record || typeof record !== "object" || !recordId) {
          return json(request, response, 400, { ok: false, error: "无效的 kind/record/recordId" });
        }
        const uniqueId = `${body.kind}:${recordId}:${record.updatedAt || record.decidedAt || record.finishedAt || ""}`;
        if (seenRecordIds.has(uniqueId)) return json(request, response, 200, { ok: true, duplicate: true });
        await serializeWrite(async () => {
          await mkdir(dataDir, { recursive: true });
          await appendJsonLines(path.join(dataDir, `${prefix}-${datePart(record.updatedAt || record.decidedAt || record.createdAt)}.encjsonl`), [record], dataKey);
        });
        seenRecordIds.add(uniqueId);
        stats.records += 1;
        return json(request, response, 201, { ok: true });
      } catch (error) {
        return json(request, response, 400, { ok: false, error: String(error?.message || error) });
      }
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/captures") {
      return json(request, response, 404, { ok: false, error: "Not found" });
    }

    try {
      if (!dataKey) return json(request, response, 503, { ok: false, error: "COLLECTOR_DATA_KEY is required" });
      const capture = await readJson(request);
      if (!capture?.captureId || !capture?.capturedAt || !capture?.matchedRule) {
        return json(request, response, 400, { ok: false, error: "缺少 captureId/capturedAt/matchedRule" });
      }
      if (seenCaptureIds.has(capture.captureId)) {
        return json(request, response, 200, { ok: true, duplicate: true, alarmRows: 0 });
      }
      const alarmRows = extractAlarmRows(capture).map((record) => ({
        captureId: capture.captureId,
        capturedAt: capture.capturedAt,
        endpoint: capture.matchedRule,
        record
      }));
      await serializeWrite(async () => {
        await mkdir(dataDir, { recursive: true });
        const day = datePart(capture.capturedAt);
        await appendJsonLines(path.join(dataDir, `captures-${day}.encjsonl`), [capture], dataKey);
        await appendJsonLines(path.join(dataDir, `alarms-${day}.encjsonl`), alarmRows, dataKey);
      });
      seenCaptureIds.add(capture.captureId);
      stats.captures += 1;
      stats.alarmRows += alarmRows.length;
      return json(request, response, 201, { ok: true, alarmRows: alarmRows.length });
    } catch (error) {
      return json(request, response, 400, { ok: false, error: String(error?.message || error) });
    }
  });
  return { server, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 17321);
  const dataDir = path.resolve(process.env.DATA_DIR || "collector-data");
  const dataKey = parseCollectorDataKey(process.env.COLLECTOR_DATA_KEY);
  const { server } = createCollectorServer({ dataDir, dataKey });
  server.listen(port, host, () => {
    console.log(`省平台采集服务已启动：http://${host}:${port}`);
    console.log(`数据目录：${dataDir}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
