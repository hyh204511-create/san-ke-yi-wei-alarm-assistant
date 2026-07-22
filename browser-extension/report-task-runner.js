import {
  REPORT_SOURCE_CONTRACTS,
  containsSensitiveKey,
  requireVerifiedReportContract,
} from "./report-source-contracts.js";

export function runnableTaskSources(task, contracts = REPORT_SOURCE_CONTRACTS) {
  const sources = Array.isArray(task?.querySpec?.sources) ? task.querySpec.sources : task?.requiredSourceTypes || [];
  return sources.map((sourceType) => requireVerifiedReportContract(sourceType, contracts));
}

export function buildSourcePageUpload({ taskId, sourceType, pageNumber, queryHash, fieldSignature, rows, deviceId, leaseToken }) {
  const payload = { sourceType, pageNumber, queryHash, fieldSignature, rows, deviceId, leaseToken };
  if (!taskId || !Number.isInteger(pageNumber) || pageNumber < 1 || !Array.isArray(rows)) {
    throw Object.assign(new Error("报表分页参数无效"), { code: "INVALID_REPORT_PAGE" });
  }
  if (containsSensitiveKey(rows)) {
    throw Object.assign(new Error("报表分页禁止包含凭证、验证码或密码"), { code: "SENSITIVE_FIELD_REJECTED" });
  }
  return payload;
}

function valueAtPath(value, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function periodBounds(task) {
  const start = String(task?.periodStart || task?.targetDate || "");
  const end = String(task?.periodEnd || task?.targetDate || start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw Object.assign(new Error("报表统计周期无效"), { code: "INVALID_REPORT_PERIOD" });
  }
  return { start, end, startTime: `${start} 00:00:00`, endTime: `${end} 23:59:59` };
}

export function buildPlatformReportRequest({ task, sourceType, pageNumber, pageSize = 500, alarmIds = [], vehicleStatusCodes = [] }) {
  const contract = requireVerifiedReportContract(sourceType);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw Object.assign(new Error("平台报表分页参数无效"), { code: "INVALID_REPORT_PAGE" });
  }
  const period = periodBounds(task);
  const paging = { [contract.pageField]: pageNumber, [contract.pageSizeField]: pageSize };
  const statuses = [...new Set(vehicleStatusCodes.map(String).filter(Boolean))];
  if (statuses.length < 2) {
    throw Object.assign(new Error("营运与营运不考核的平台状态范围尚未完整确认"), { code: "VEHICLE_STATUS_SCOPE_UNCONFIRMED" });
  }
  if (sourceType === "VEHICLE_BASE_INFO") {
    return { manufactorName: "", certId: "", groupId: [], vehicleStatus: statuses, ...paging };
  }
  if (sourceType === "TRACK_COMPLETENESS") {
    return {
      tt: "", kpiType: 4, areaCode: "", companyId: "", carId: "",
      linType: [1, 2, 3, 4], vehicleStatus: statuses, startTime: period.start,
      endTime: period.end, ...paging,
    };
  }
  const selectedAlarmIds = [...new Set(alarmIds.map(String).filter(Boolean))];
  if (!selectedAlarmIds.length) {
    throw Object.assign(new Error("报警类型全选范围无法确认"), { code: "ALARM_SCOPE_UNCONFIRMED" });
  }
  const alarmBase = {
    searchFlag: "1", latitudeSelection: "5", groupIdList: [], certId: "", vehicleStatus: statuses, timeType: "2",
    alarmQueryStartTime: period.startTime, alarmQueryEndTime: period.endTime,
    alarmIds: selectedAlarmIds,
    ...paging,
  };
  if (sourceType === "ALARM_CENTER") {
    return { ...alarmBase, driverName: "", dispositionMode: "", manufactorId: "" };
  }
  return alarmBase;
}

function validateRawRowFields(rawRows, contract) {
  const expected = [...(contract.rawRowFields || [])].sort();
  if (!expected.length) throw Object.assign(new Error("来源原始字段契约为空"), { code: "REPORT_CONTRACT_MISMATCH" });
  for (const row of rawRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw Object.assign(new Error("来源原始行结构无效"), { code: "REPORT_CONTRACT_MISMATCH" });
    }
    const actual = Object.keys(row).filter((key) => !/^\d{6,30}$/.test(key)).sort();
    if (stableJson(actual) !== stableJson(expected)) {
      throw Object.assign(new Error("省平台原始字段与已审核契约不一致"), { code: "REPORT_RAW_FIELDS_CHANGED" });
    }
  }
}

function standardAlarmRow(raw, contract) {
  const values = {};
  for (const [header, field] of Object.entries(contract.valueAliases || {})) values[header] = raw?.[field] ?? null;
  for (const [field, value] of Object.entries(raw || {})) {
    if (/^\d{6,30}$/.test(field) && values[field] === undefined) values[field] = value;
  }
  return {
    enterpriseId: String(raw?.[contract.fieldAliases.enterpriseId] ?? ""),
    enterpriseName: String(raw?.[contract.fieldAliases.enterpriseName] ?? ""),
    values,
  };
}

export function standardizeReportRows(sourceType, rawRows, contract = REPORT_SOURCE_CONTRACTS[sourceType]) {
  if (!Array.isArray(rawRows)) throw Object.assign(new Error("平台报表行不是数组"), { code: "REPORT_ROWS_INVALID" });
  if (sourceType.startsWith("ALARM_")) return rawRows.map((row) => standardAlarmRow(row, contract));
  const alias = contract.fieldAliases;
  if (sourceType === "VEHICLE_BASE_INFO") {
    return rawRows.map((row) => ({
      vehicleId: String(row?.[alias.vehicleId] ?? ""), plate: String(row?.[alias.plate] ?? ""),
      enterpriseId: String(row?.[alias.enterpriseId] ?? ""), enterpriseName: String(row?.[alias.enterpriseName] ?? ""),
      vehicleStatus: String(row?.vehicleStatus ?? ""), lastLocationTime: row?.[alias.lastLocationTime] ?? null,
    }));
  }
  return rawRows.map((row) => ({
    vehicleId: String(row?.[alias.vehicleId] ?? ""), plate: String(row?.[alias.plate] ?? ""),
    enterpriseId: String(row?.[alias.enterpriseId] ?? ""), enterpriseName: String(row?.[alias.enterpriseName] ?? ""),
    totalMileage: row?.[alias.totalMileage] ?? null, completeness: row?.[alias.completeness] ?? null,
  }));
}

export function parsePlatformReportPage(sourceType, payload, contract = REPORT_SOURCE_CONTRACTS[sourceType]) {
  if (!payload || typeof payload !== "object" || payload.success === false) {
    throw Object.assign(new Error("省平台报表接口返回失败"), { code: "PLATFORM_REPORT_FAILED" });
  }
  const rawRows = valueAtPath(payload, contract.rowsPath);
  const total = Number(valueAtPath(payload, contract.totalPath));
  if (!Array.isArray(rawRows) || !Number.isInteger(total) || total < 0) {
    throw Object.assign(new Error("省平台报表响应结构与已确认契约不一致"), { code: "REPORT_CONTRACT_MISMATCH" });
  }
  validateRawRowFields(rawRows, contract);
  return { rows: standardizeReportRows(sourceType, rawRows, contract), rawRowCount: rawRows.length, total };
}

function shapeOfStandardValue(value) {
  if (Array.isArray(value)) return value.length ? [shapeOfStandardValue(value[0])] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOfStandardValue(value[key])]));
  }
  return "value";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function standardRowsFieldSignature(rows) {
  const shapes = [...new Set((rows || []).slice(0, 20).map((row) => stableJson(shapeOfStandardValue(row))))].sort();
  const bytes = new TextEncoder().encode(stableJson(shapes));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function pollReportTasks({ assistantGet, identity, contracts = REPORT_SOURCE_CONTRACTS }) {
  if (!identity?.authenticated || !(identity.permissions || []).includes("report.collect")) {
    return { code: "REPORT_COLLECT_PERMISSION_REQUIRED", tasks: [] };
  }
  const response = await assistantGet("/reports/api/tasks");
  const tasks = Array.isArray(response?.data) ? response.data : [];
  const runnable = [];
  const blocked = [];
  for (const task of tasks.filter((item) => item.status === "WAITING_PLATFORM" || item.status === "FETCHING")) {
    try {
      runnableTaskSources(task, contracts);
      runnable.push(task);
    } catch (error) {
      blocked.push({ taskId: task.taskId, code: error.code || "REPORT_CONTRACT_UNVERIFIED" });
    }
  }
  return { code: runnable.length ? "REPORT_TASKS_READY" : "NO_RUNNABLE_REPORT_TASKS", tasks: runnable, blocked };
}
