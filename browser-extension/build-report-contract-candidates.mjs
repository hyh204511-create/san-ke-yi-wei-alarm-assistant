import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPORT_SOURCE_TYPES } from "./report-source-contracts.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stripRoot(value) {
  return String(value || "").replace(/^request\.?/, "").replace(/^response\.?/, "");
}

function fieldNames(shape, prefix) {
  return Object.keys(shape || {}).filter((key) => key.startsWith(prefix)).map(stripRoot).sort();
}

function firstField(shape, candidates) {
  const keys = Object.keys(shape || {});
  for (const candidate of candidates) {
    const key = keys.find((item) => {
      const normalized = stripRoot(item).replace(/\[\]$/g, "");
      return normalized === candidate || normalized.endsWith(`.${candidate}`);
    });
    if (key) return stripRoot(key);
  }
  return "";
}

function rowsPath(responseShape) {
  const candidates = Object.entries(responseShape || {})
    .filter(([key, types]) => key.startsWith("response.") && Array.isArray(types) && types.includes("array"))
    .map(([key]) => stripRoot(key))
    .filter((key) => !key.endsWith("[]"))
    .sort((left, right) => left.split(".").length - right.split(".").length || left.localeCompare(right));
  return candidates[0] || "";
}

function dominantRoute(routes) {
  return Object.entries(routes || {}).sort(([, left], [, right]) => right - left)[0]?.[0] || "";
}

export function buildReportContractCandidates(summary) {
  const contracts = Array.isArray(summary?.contracts) ? summary.contracts : [];
  const output = {
    schemaVersion: 1,
    classification: "SANITIZED_REPORT_CONTRACT_CANDIDATES",
    generatedAt: new Date().toISOString(),
    readyForReview: true,
    sources: {},
  };
  for (const sourceType of REPORT_SOURCE_TYPES) {
    const matches = contracts
      .filter((item) => item.reportSourceType === sourceType && ["GET", "POST"].includes(item.method))
      .sort((left, right) => Number(right.count || 0) - Number(left.count || 0));
    if (!matches.length) {
      output.sources[sourceType] = { status: "MISSING", candidates: [] };
      output.readyForReview = false;
      continue;
    }
    const best = matches[0];
    const rows = rowsPath(best.responseShape);
    const rowPrefix = rows ? `response.${rows}[]` : "";
    const rowFields = rowPrefix ? fieldNames(best.responseShape, rowPrefix) : [];
    const candidate = {
      enabled: false,
      reviewStatus: matches.length === 1 ? "REVIEW_REQUIRED" : "AMBIGUOUS",
      sourceType,
      version: "CANDIDATE_V1",
      route: dominantRoute(best.routes),
      method: best.method,
      path: best.endpointPath,
      requestFields: fieldNames(best.requestShape, "request."),
      pageField: firstField(best.requestShape, ["pageNum", "pageNo", "page", "current"]),
      pageSizeField: firstField(best.requestShape, ["pageSize", "size", "limit"]),
      rowsPath: rows,
      totalPath: firstField(best.responseShape, ["total", "dataCount", "count"]),
      totalPagesPath: firstField(best.responseShape, ["totalPage", "totalPages", "pages"]),
      fieldSignature: rowFields.length ? sha256(JSON.stringify(rowFields)) : "",
      rowFields,
      observationCount: Number(best.count || 0),
      successfulResponses: Number(best.statuses?.["200"] || 0),
      alternatives: matches.slice(1).map((item) => ({ method: item.method, path: item.endpointPath, count: item.count })),
    };
    const complete = candidate.route && candidate.path && candidate.pageField && candidate.pageSizeField
      && candidate.rowsPath && candidate.totalPath
      && candidate.fieldSignature && candidate.observationCount > 0 && candidate.successfulResponses > 0;
    output.sources[sourceType] = { status: complete && matches.length === 1 ? "READY_FOR_REVIEW" : "INCOMPLETE", candidate };
    if (!complete || matches.length !== 1) output.readyForReview = false;
  }
  return output;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const inputPath = path.resolve(process.env.INPUT_PATH || "contract-summary.local.json");
  const outputPath = path.resolve(process.env.OUTPUT_PATH || "report-contract-candidates.local.json");
  const summary = JSON.parse(await readFile(inputPath, "utf8"));
  const result = buildReportContractCandidates(summary);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, readyForReview: result.readyForReview, outputPath }));
}
