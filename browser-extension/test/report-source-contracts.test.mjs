import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  REPORT_SOURCE_CONTRACTS,
  REPORT_SOURCE_TYPES,
  sanitizeContractObservation,
  requireVerifiedReportContract,
} from "../report-source-contracts.js";
import {
  buildPlatformReportRequest,
  buildSourcePageUpload,
  executeClaimedReportTask,
  extractAlarmDictionaryIds,
  parsePlatformReportPage,
  pollReportTasks,
  standardRowsFieldSignature,
} from "../report-task-runner.js";

test("五来源使用已确认的真实路由和接口契约", () => {
  assert.equal(REPORT_SOURCE_TYPES.length, 5);
  for (const source of REPORT_SOURCE_TYPES) {
    const contract = requireVerifiedReportContract(source);
    assert.equal(contract.enabled, true);
    assert.equal(contract.version, "HN_PLATFORM_2026_07_23_V1");
    assert.match(contract.route, /^#\//);
    assert.match(contract.path, /^\/api\//);
    assert.match(contract.fieldSignature, /^[0-9a-f]{64}$/);
  }
  assert.equal(REPORT_SOURCE_CONTRACTS.ALARM_DISPOSAL_RATE.path, "/api/report-service/alarm/info/alarmResponseRateCount");
  assert.equal(REPORT_SOURCE_CONTRACTS.ALARM_PROCESSING_RATE.path, "/api/report-service/alarm/info/alarmProcessingRateCount");
  assert.equal(REPORT_SOURCE_CONTRACTS.ALARM_CENTER.path, "/api/report-service/alarm/info/alarmInformationQueryReport");
  assert.equal(REPORT_SOURCE_CONTRACTS.VEHICLE_BASE_INFO.path, "/api/report-service/alarmDriverFaceResult/queryVehicleList");
  assert.equal(REPORT_SOURCE_CONTRACTS.TRACK_COMPLETENESS.path, "/api/report-service/network/kpi/mile");
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

test("日报周报月报请求统一使用服务器接收时间和车辆维度", () => {
  const task = { periodStart: "2026-07-01", periodEnd: "2026-07-31" };
  const request = buildPlatformReportRequest({
    task, sourceType: "ALARM_PROCESSING_RATE", pageNumber: 2, pageSize: 500,
    alarmIds: ["speeding-id", "speeding-id", "fatigue-id"],
    vehicleStatusCodes: ["10", "OPERATING_NOT_ASSESSED_CONFIRMED_CODE"],
  });
  assert.equal(request.searchFlag, "1");
  assert.equal(request.latitudeSelection, "5");
  assert.equal(request.timeType, "2");
  assert.equal(request.alarmQueryStartTime, "2026-07-01 00:00:00");
  assert.equal(request.alarmQueryEndTime, "2026-07-31 23:59:59");
  assert.deepEqual(request.alarmIds, ["speeding-id", "fatigue-id"]);
  assert.equal(request.pageNum, 2);
  assert.equal(request.pageSize, 500);
});

test("五来源响应转换为服务端标准行且结构变化立即阻断", () => {
  const disposalRow = Object.fromEntries(
    REPORT_SOURCE_CONTRACTS.ALARM_DISPOSAL_RATE.rawRowFields.map((field) => [field, null]),
  );
  Object.assign(disposalRow, {
    groupId: "enterprise-1", mechanism: "合成企业", certId: "模拟车",
    alarmCount: 3, disposalRate: "100%",
  });
  const disposal = parsePlatformReportPage("ALARM_DISPOSAL_RATE", {
    success: true, total: 1,
    data: [{}, [disposalRow], {}],
  });
  assert.equal(disposal.total, 1);
  assert.deepEqual(disposal.rows[0], {
    enterpriseId: "enterprise-1", enterpriseName: "合成企业",
    values: {
      "机构": "合成企业", "类型": null, "车牌号": "模拟车", "车牌颜色": null,
      "所属地市": null, "正报总数": null, "申诉通过数": null, "判断中总数": null,
      "车辆报警总数": 3, "处置率": "100%", "已处置报警数": null,
      "未处置报警数": null, "异常申诉数": null, "异常申诉通过数": null,
    },
  });
  const track = parsePlatformReportPage("TRACK_COMPLETENESS", {
    success: true, total: 1,
    data: [{ carId: "vehicle-1", certId: "模拟车", companyId: "enterprise-1", companyName: "合成企业", totalMile: 0, continuousMileRateStr: "100%" }],
  });
  assert.equal(track.rows[0].totalMileage, 0);
  assert.equal(track.rows[0].completeness, "100%");
  assert.throws(
    () => parsePlatformReportPage("VEHICLE_BASE_INFO", { success: true, data: { rows: [] }, total: 0 }),
    (error) => error.code === "REPORT_CONTRACT_MISMATCH",
  );
  assert.throws(
    () => parsePlatformReportPage("TRACK_COMPLETENESS", {
      success: true, total: 1,
      data: [{ carId: "v1", certId: "模拟车", companyId: "e1", companyName: "合成企业", totalMile: 1 }],
    }),
    (error) => error.code === "REPORT_RAW_FIELDS_CHANGED",
  );
});

test("无法证明车辆状态全范围或报警类型全选时禁止取数", () => {
  const task = { periodStart: "2026-07-21", periodEnd: "2026-07-21" };
  assert.throws(
    () => buildPlatformReportRequest({ task, sourceType: "VEHICLE_BASE_INFO", pageNumber: 1, vehicleStatusCodes: ["10"] }),
    (error) => error.code === "VEHICLE_STATUS_SCOPE_UNCONFIRMED",
  );
  assert.throws(
    () => buildPlatformReportRequest({ task, sourceType: "ALARM_CENTER", pageNumber: 1, vehicleStatusCodes: ["10", "confirmed-second"] }),
    (error) => error.code === "ALARM_SCOPE_UNCONFIRMED",
  );
});

test("标准行字段签名与业务值无关并保持64位哈希", async () => {
  const first = [{ vehicleId: "v1", plate: "A", enterpriseId: "e1", enterpriseName: "企业A", vehicleStatus: "10", lastLocationTime: "2026-07-21" }];
  const second = [{ vehicleId: "v2", plate: "B", enterpriseId: "e2", enterpriseName: "企业B", vehicleStatus: "10", lastLocationTime: null }];
  const left = await standardRowsFieldSignature(first);
  const right = await standardRowsFieldSignature(second);
  assert.match(left, /^[0-9a-f]{64}$/);
  assert.equal(left, right);
});

test("轮询能识别包含已确认五来源契约的任务", async () => {
  let calls = 0;
  const result = await pollReportTasks({
    identity: { authenticated: true, permissions: ["report.collect"] },
    assistantGet: async () => {
      calls += 1;
      return { data: [{ taskId: "t1", status: "WAITING_PLATFORM", requiredSourceTypes: ["VEHICLE_BASE_INFO", "TRACK_COMPLETENESS"] }] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.blocked, []);
});

test("报表导航只点击已确认菜单和轨迹页签，不点击查询或导出", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const navigation = content.slice(
    content.indexOf("const REPORT_NAVIGATION"),
    content.indexOf("async function navigateRealtimeMonitor"),
  );
  for (const route of [
    "#/report-center/alarm-disposal-rate",
    "#/report-center/alarm-process-rate",
    "#/report-center/alarm-info",
    "#/report-center/vehicle-mes",
    "#/network-monitor/examine-list",
  ]) assert.match(navigation, new RegExp(route.replace(/[/-]/g, "\\$&")));
  assert.match(navigation, /轨迹完整率明细/);
  assert.match(navigation, /length !== 1/);
  assert.equal((navigation.match(/\.click\(\)/g) || []).length, 3);
  assert.doesNotMatch(navigation, /导出|语音对讲|文本下发|查岗|申诉/);
});

test("报警字典只接受固定data路径和alarmId/alarmName字段且拒绝重复", () => {
  assert.deepEqual(extractAlarmDictionaryIds({ data: [{ alarmId: 1, alarmName: "超速" }, { alarmId: 2, alarmName: "疲劳" }] }), ["1", "2"]);
  assert.throws(() => extractAlarmDictionaryIds({ rows: [{ id: 1, name: "普通对象" }] }), (error) => error.code === "ALARM_DICTIONARY_CONTRACT_MISMATCH");
  assert.throws(() => extractAlarmDictionaryIds({ data: [{ alarmId: 1, alarmName: "超速" }, { alarmId: 1, alarmName: "重复" }] }), (error) => error.code === "ALARM_DICTIONARY_CONTRACT_MISMATCH");
});

test("分页总数漂移、短页和无法证明契约的空结果全部阻断", async () => {
  const raw = Object.fromEntries(REPORT_SOURCE_CONTRACTS.VEHICLE_BASE_INFO.rawRowFields.map((field) => [field, null]));
  Object.assign(raw, { carId: "v1", certId: "模拟车", groupId: "e1", groupName: "合成企业", vehicleStatus: "10" });
  const task = {
    taskId: "task-drift", periodStart: "2026-07-21", periodEnd: "2026-07-21",
    requiredSourceTypes: ["VEHICLE_BASE_INFO"],
    querySpec: { conditions: { platformVehicleStatusCodes: ["10", "confirmed-second"] } },
    sources: [{ sourceType: "VEHICLE_BASE_INFO", queryHash: "query-hash" }],
  };
  const execute = (responses, pageSize = 2) => executeClaimedReportTask({
    task, deviceId: "device", leaseToken: "lease", pageSize,
    navigateSource: async () => {}, fetchAlarmDictionary: async () => ({}),
    fetchPage: async () => responses.shift(), uploadPage: async () => {}, completeSource: async () => {}, finalizeTask: async () => {},
  });
  await assert.rejects(
    execute([{ success: true, total: 3, data: [raw, { ...raw, carId: "v2" }] }, { success: true, total: 2, data: [] }]),
    (error) => error.code === "REPORT_TOTAL_CHANGED",
  );
  await assert.rejects(
    execute([{ success: true, total: 3, data: [raw] }]),
    (error) => error.code === "REPORT_PAGE_SIZE_MISMATCH",
  );
  await assert.rejects(
    execute([{ success: true, total: 0, data: [] }]),
    (error) => error.code === "REPORT_EMPTY_RESULT_UNVERIFIED",
  );
});

test("已领取任务按页上传、结束来源并最终提交审核", async () => {
  const calls = [];
  const task = {
    taskId: "task-1", periodStart: "2026-07-21", periodEnd: "2026-07-21",
    requiredSourceTypes: ["VEHICLE_BASE_INFO"],
    querySpec: { conditions: { platformVehicleStatusCodes: ["10", "confirmed-second"] } },
    sources: [{ sourceType: "VEHICLE_BASE_INFO", queryHash: "query-hash" }],
  };
  const raw = Object.fromEntries(REPORT_SOURCE_CONTRACTS.VEHICLE_BASE_INFO.rawRowFields.map((field) => [field, null]));
  Object.assign(raw, { carId: "v1", certId: "模拟车", groupId: "e1", groupName: "合成企业", vehicleStatus: "10" });
  const result = await executeClaimedReportTask({
    task, deviceId: "device", leaseToken: "lease",
    navigateSource: async (source) => calls.push(["navigate", source]),
    fetchAlarmDictionary: async () => { throw new Error("车辆任务不应读取报警字典"); },
    fetchPage: async (source, body) => { calls.push(["fetch", source, body.pageNum]); return { success: true, total: 1, data: [raw] }; },
    uploadPage: async (body) => calls.push(["upload", body.sourceType, body.pageNumber, body.rows.length]),
    completeSource: async (source, body) => calls.push(["complete", source, body.totalPages, body.totalRows]),
    finalizeTask: async () => ({ status: "REVIEW_REQUIRED" }),
  });
  assert.equal(result.code, "REPORT_TASK_REVIEW_REQUIRED");
  assert.deepEqual(calls, [
    ["navigate", "VEHICLE_BASE_INFO"], ["fetch", "VEHICLE_BASE_INFO", 1],
    ["upload", "VEHICLE_BASE_INFO", 1, 1], ["complete", "VEHICLE_BASE_INFO", 1, 1],
  ]);
});
