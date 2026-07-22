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
