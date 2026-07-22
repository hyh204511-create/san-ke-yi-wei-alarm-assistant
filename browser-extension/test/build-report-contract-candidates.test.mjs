import test from "node:test";
import assert from "node:assert/strict";

import { buildReportContractCandidates } from "../build-report-contract-candidates.mjs";

function contract(sourceType) {
  return {
    reportSourceType: sourceType, matchedRule: `report-${sourceType.toLowerCase()}-discovery`,
    method: "POST", endpointPath: `/api/report/${sourceType.toLowerCase()}/list`, count: 3,
    statuses: { "200": 3 }, routes: { "#/report/verified": 3 },
    requestShape: { "request": ["object"], "request.pageNum": ["number"], "request.pageSize": ["number"] },
    responseShape: {
      "response": ["object"], "response.data": ["array"], "response.data[]": ["object"],
      "response.data[].vehicleId": ["string"], "response.data[].enterpriseId": ["string"],
      "response.total": ["number"], "response.totalPage": ["number"],
    },
  };
}

test("five complete sanitized sources become review candidates without enabling execution", () => {
  const sources = ["ALARM_DISPOSAL_RATE", "ALARM_PROCESSING_RATE", "ALARM_CENTER", "VEHICLE_BASE_INFO", "TRACK_COMPLETENESS"];
  const result = buildReportContractCandidates({ contracts: sources.map(contract) });
  assert.equal(result.readyForReview, true);
  for (const source of sources) {
    const candidate = result.sources[source].candidate;
    assert.equal(result.sources[source].status, "READY_FOR_REVIEW");
    assert.equal(candidate.enabled, false);
    assert.equal(candidate.pageField, "pageNum");
    assert.equal(candidate.rowsPath, "data");
    assert.equal(candidate.totalPath, "total");
    assert.match(candidate.fieldSignature, /^[0-9a-f]{64}$/);
  }
});

test("missing or ambiguous sources cannot be promoted", () => {
  const one = contract("VEHICLE_BASE_INFO");
  const result = buildReportContractCandidates({ contracts: [one, { ...one, endpointPath: "/api/report/other/list", count: 1 }] });
  assert.equal(result.readyForReview, false);
  assert.equal(result.sources.VEHICLE_BASE_INFO.status, "INCOMPLETE");
  assert.equal(result.sources.TRACK_COMPLETENESS.status, "MISSING");
});

test("nested paging fields are recognized but missing page size remains incomplete", () => {
  const nested = contract("VEHICLE_BASE_INFO");
  nested.requestShape = {
    "request": ["object"], "request.query": ["object"],
    "request.query.pageNo": ["number"], "request.query.limit": ["number"],
  };
  nested.responseShape = {
    "response": ["object"], "response.data": ["object"], "response.data.rows": ["array"],
    "response.data.rows[]": ["object"], "response.data.rows[].vehicleId": ["string"],
    "response.data.total": ["number"],
  };
  let result = buildReportContractCandidates({ contracts: [nested] });
  assert.equal(result.sources.VEHICLE_BASE_INFO.status, "READY_FOR_REVIEW");
  assert.equal(result.sources.VEHICLE_BASE_INFO.candidate.pageField, "query.pageNo");
  assert.equal(result.sources.VEHICLE_BASE_INFO.candidate.totalPath, "data.total");

  delete nested.requestShape["request.query.limit"];
  result = buildReportContractCandidates({ contracts: [nested] });
  assert.equal(result.sources.VEHICLE_BASE_INFO.status, "INCOMPLETE");
  assert.equal(result.readyForReview, false);
});
