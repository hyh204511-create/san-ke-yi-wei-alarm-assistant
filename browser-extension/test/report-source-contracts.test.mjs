import test from "node:test";
import assert from "node:assert/strict";

import {
  REPORT_SOURCE_CONTRACTS,
  REPORT_SOURCE_TYPES,
  sanitizeContractObservation,
  requireVerifiedReportContract,
} from "../report-source-contracts.js";
import { buildSourcePageUpload, pollReportTasks } from "../report-task-runner.js";

test("五来源默认全部阻断，且没有猜测接口", () => {
  assert.equal(REPORT_SOURCE_TYPES.length, 5);
  for (const source of REPORT_SOURCE_TYPES) {
    assert.equal(REPORT_SOURCE_CONTRACTS[source].enabled, false);
    assert.equal(REPORT_SOURCE_CONTRACTS[source].path, "");
    assert.throws(() => requireVerifiedReportContract(source), (error) => error.code === "REPORT_CONTRACT_UNVERIFIED");
  }
});

test("契约观察只保留结构并拒绝凭证", () => {
  const safe = sanitizeContractObservation({
    url: "https://demo.hnznjg.cn/api/report/list?enterprise=real-value",
    method: "post",
    requestBody: { page: 1, filters: { status: ["a"] } },
    responseBody: { data: { rows: [{ vehicleId: "真实值不会保留" }], total: 1 } },
    observedAt: "2026-07-23T00:00:00+08:00",
  });
  assert.equal(safe.path, "/api/report/list");
  assert.deepEqual(safe.requestShape, { filters: { status: ["string"] }, page: "number" });
  assert.deepEqual(safe.responseShape, { data: { rows: [{ vehicleId: "string" }], total: "number" } });
  assert.equal(JSON.stringify(safe).includes("真实值"), false);
  assert.throws(() => sanitizeContractObservation({
    url: "https://demo.hnznjg.cn/api/report/list", requestBody: { authorization: "secret" },
  }), (error) => error.code === "SENSITIVE_FIELD_REJECTED");
});

test("分页载荷拒绝嵌套敏感字段", () => {
  assert.throws(() => buildSourcePageUpload({
    taskId: "task", sourceType: "VEHICLE_BASE_INFO", pageNumber: 1,
    queryHash: "q", fieldSignature: "f", deviceId: "device", leaseToken: "lease",
    rows: [{ vehicleId: "v1", metadata: { cookie: "forbidden" } }],
  }), (error) => error.code === "SENSITIVE_FIELD_REJECTED");
});

test("轮询能看到任务但不会领取未验证来源", async () => {
  let calls = 0;
  const result = await pollReportTasks({
    identity: { authenticated: true, permissions: ["report.collect"] },
    assistantGet: async () => {
      calls += 1;
      return { data: [{ taskId: "t1", status: "WAITING_PLATFORM", requiredSourceTypes: ["VEHICLE_BASE_INFO", "TRACK_COMPLETENESS"] }] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.tasks.length, 0);
  assert.deepEqual(result.blocked, [{ taskId: "t1", code: "REPORT_CONTRACT_UNVERIFIED" }]);
});
