export const REPORT_SOURCE_TYPES = Object.freeze([
  "ALARM_DISPOSAL_RATE",
  "ALARM_PROCESSING_RATE",
  "ALARM_CENTER",
  "VEHICLE_BASE_INFO",
  "TRACK_COMPLETENESS",
]);

const UNVERIFIED = Object.freeze({
  enabled: false,
  version: "UNVERIFIED",
  route: "",
  method: "",
  path: "",
  requestFields: Object.freeze([]),
  pageField: "",
  pageSizeField: "",
  rowsPath: "",
  totalPath: "",
  fieldAliases: Object.freeze({}),
  fieldSignature: "",
});

export const REPORT_SOURCE_CONTRACTS = Object.freeze(Object.fromEntries(
  REPORT_SOURCE_TYPES.map((sourceType) => [sourceType, Object.freeze({ sourceType, ...UNVERIFIED })]),
));

const SENSITIVE_KEY = /(?:^|[_-])(cookie|authorization|token|access[_-]?token|refresh[_-]?token|captcha|verify[_-]?code|password|passwd|secret)(?:$|[_-])/i;

export function containsSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(item));
}

function shapeOf(value, depth = 0) {
  if (depth > 6) return "depth-limit";
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key], depth + 1)]));
  }
  if (value === null) return "null";
  return typeof value;
}

export function sanitizeContractObservation(observation) {
  const url = new URL(String(observation?.url || ""));
  if (url.protocol !== "https:" || !/(^|\.)hnznjg\.cn$/i.test(url.hostname)) {
    throw Object.assign(new Error("只允许分析省平台 HTTPS 接口"), { code: "REPORT_CONTRACT_HOST_DENIED" });
  }
  const request = observation?.requestBody ?? null;
  const response = observation?.responseBody ?? null;
  if (containsSensitiveKey(request) || containsSensitiveKey(response) || containsSensitiveKey(observation?.headers || {})) {
    throw Object.assign(new Error("契约样本包含凭证或验证码字段"), { code: "SENSITIVE_FIELD_REJECTED" });
  }
  return {
    method: String(observation?.method || "GET").toUpperCase(),
    path: url.pathname,
    requestShape: shapeOf(request),
    responseShape: shapeOf(response),
    observedAt: new Date(observation?.observedAt || Date.now()).toISOString(),
  };
}

export function requireVerifiedReportContract(sourceType, contracts = REPORT_SOURCE_CONTRACTS) {
  const contract = contracts[sourceType];
  const valid = contract && contract.enabled === true && contract.version !== "UNVERIFIED"
    && /^#\/[A-Za-z0-9_./-]+$/.test(contract.route)
    && ["GET", "POST"].includes(contract.method)
    && /^\/api\/[A-Za-z0-9_./-]+$/.test(contract.path)
    && contract.rowsPath && contract.totalPath && contract.fieldSignature;
  if (!valid) {
    throw Object.assign(new Error(`来源 ${sourceType} 的真实接口契约尚未审核`), {
      code: "REPORT_CONTRACT_UNVERIFIED",
      sourceType,
    });
  }
  return contract;
}
