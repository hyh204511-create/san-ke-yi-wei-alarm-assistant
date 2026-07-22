export const REPORT_SOURCE_TYPES = Object.freeze([
  "ALARM_DISPOSAL_RATE",
  "ALARM_PROCESSING_RATE",
  "ALARM_CENTER",
  "VEHICLE_BASE_INFO",
  "TRACK_COMPLETENESS",
]);

const CONTRACT_VERSION = "HN_PLATFORM_2026_07_23_V1";
const verified = (sourceType, contract) => Object.freeze({
  sourceType,
  enabled: true,
  version: CONTRACT_VERSION,
  method: "POST",
  pageField: "pageNum",
  pageSizeField: "pageSize",
  ...contract,
  requestFields: Object.freeze(contract.requestFields),
  rawRowFields: Object.freeze(contract.rawRowFields),
  fieldAliases: Object.freeze(contract.fieldAliases),
  valueAliases: Object.freeze(contract.valueAliases || {}),
});

export const REPORT_SOURCE_CONTRACTS = Object.freeze({
  ALARM_DISPOSAL_RATE: verified("ALARM_DISPOSAL_RATE", {
    route: "#/report-center/alarm-disposal-rate",
    path: "/api/report-service/alarm/info/alarmResponseRateCount",
    rowsPath: "data.1", totalPath: "total",
    requestFields: ["searchFlag", "latitudeSelection", "groupIdList", "certId", "vehicleStatus", "timeType", "alarmQueryStartTime", "alarmQueryEndTime", "alarmIds", "pageNum", "pageSize"],
    rawRowFields: ["alarmCount", "alarmsDisposedCount", "alarmsNoDisposedCount", "approvedAndReported", "certColorName", "certId", "disposalRate", "driverAppealCount", "driverAppealPassCount", "groupId", "mechanism", "positiveAlarmsReported", "superior", "sysType", "totalNumberInJudgment"],
    fieldAliases: { enterpriseId: "groupId", enterpriseName: "mechanism" },
    valueAliases: { "机构": "mechanism", "类型": "sysType", "车牌号": "certId", "车牌颜色": "certColorName", "所属地市": "superior", "正报总数": "positiveAlarmsReported", "申诉通过数": "approvedAndReported", "判断中总数": "totalNumberInJudgment", "车辆报警总数": "alarmCount", "处置率": "disposalRate", "已处置报警数": "alarmsDisposedCount", "未处置报警数": "alarmsNoDisposedCount", "异常申诉数": "driverAppealCount", "异常申诉通过数": "driverAppealPassCount" },
    fieldSignature: "0ba2b1c288c280113d6f57afde269e8120c0908c00093dd515f46cc4d9b01e25",
  }),
  ALARM_PROCESSING_RATE: verified("ALARM_PROCESSING_RATE", {
    route: "#/report-center/alarm-process-rate",
    path: "/api/report-service/alarm/info/alarmProcessingRateCount",
    rowsPath: "data.1", totalPath: "total",
    requestFields: ["searchFlag", "latitudeSelection", "groupIdList", "certId", "vehicleStatus", "timeType", "alarmQueryStartTime", "alarmQueryEndTime", "alarmIds", "pageNum", "pageSize"],
    rawRowFields: ["alarmCount", "approvedAndReported", "certColorName", "certId", "driverAppealCount", "driverAppealPassCount", "groupId", "mechanism", "noNumberOfProcessedAlarms", "noTowardsProcessingRate", "numberOfProcessedAlarms", "positiveAlarmsReported", "processingRate", "superior", "sysType", "totalNumberInJudgment", "towardsProcessingRate"],
    fieldAliases: { enterpriseId: "groupId", enterpriseName: "mechanism" },
    valueAliases: { "机构": "mechanism", "类型": "sysType", "车牌号": "certId", "车牌颜色": "certColorName", "所属地市": "superior", "正报总数": "positiveAlarmsReported", "申诉通过总数": "approvedAndReported", "判断中总数": "totalNumberInJudgment", "车辆报警总数": "alarmCount", "处理率": "processingRate", "已处理报警数": "numberOfProcessedAlarms", "未处理报警数": "noNumberOfProcessedAlarms", "计入处理率报警": "towardsProcessingRate", "未计入处理率报警": "noTowardsProcessingRate", "异常申诉数": "driverAppealCount", "异常申诉通过数": "driverAppealPassCount" },
    fieldSignature: "daa89ae445ed2ba6466742d264f6627ff17baf2b2994121b2d4b6cb572e7d485",
  }),
  ALARM_CENTER: verified("ALARM_CENTER", {
    route: "#/report-center/alarm-info",
    path: "/api/report-service/alarm/info/alarmInformationQueryReport",
    rowsPath: "data", totalPath: "total",
    requestFields: ["searchFlag", "latitudeSelection", "groupIdList", "certId", "driverName", "dispositionMode", "vehicleStatus", "alarmIds", "timeType", "manufactorId", "alarmQueryStartTime", "alarmQueryEndTime", "pageNum", "pageSize"],
    rawRowFields: ["alarmName", "alarmTime", "carId", "certColorName", "certId", "cityName", "countyName", "groupId", "groupName", "id", "traceno"],
    fieldAliases: { enterpriseId: "groupId", enterpriseName: "groupName" },
    valueAliases: { "状态": "alarmStatusName", "报警ID": "id", "类型": "sysType", "车牌号": "certId", "终端版本": "versions", "车牌颜色": "certColorName", "驾驶员": "driverName", "报警类型": "alarmName", "报警详情": "detail", "发生时间": "alarmTime", "市州": "cityName", "区县": "countyName", "所属机构": "groupName", "设备厂商": "manufactorIdStr", "设备型号": "modelIdStr", "定位速度(公里/时)": "speed", "仪表盘速度(公里/时)": "recorderSpeed", "车型类型": "sysType", "接收时间": "traceno", "处置时间": "dispositionTime", "处置人": "dispositionOperid", "处置方式": "dispositionMode", "处置内容": "dispositionText", "报警地址": "posDesc" },
    fieldSignature: "194340eff56f4deab4e3452e5ae77b38610612b146317a6ca5a87cbbaf4a56a4",
  }),
  VEHICLE_BASE_INFO: verified("VEHICLE_BASE_INFO", {
    route: "#/report-center/vehicle-mes",
    path: "/api/report-service/alarmDriverFaceResult/queryVehicleList",
    rowsPath: "data", totalPath: "total",
    requestFields: ["manufactorName", "certId", "groupId", "vehicleStatus", "pageNum", "pageSize"],
    rawRowFields: ["carId", "certId", "groupId", "groupName", "loctime", "totalMile", "vehicleStatus"],
    fieldAliases: { vehicleId: "carId", plate: "certId", enterpriseId: "groupId", enterpriseName: "groupName", lastLocationTime: "loctime" },
    fieldSignature: "d1e5198031a7228e828eb0c98aad4f699aa6bd78648b1f6ba0f204b09e5f939f",
  }),
  TRACK_COMPLETENESS: verified("TRACK_COMPLETENESS", {
    route: "#/network-monitor/examine-list",
    path: "/api/report-service/network/kpi/mile",
    rowsPath: "data", totalPath: "total",
    requestFields: ["tt", "kpiType", "areaCode", "companyId", "carId", "linType", "vehicleStatus", "startTime", "endTime", "pageNum", "pageSize"],
    rawRowFields: ["carId", "certId", "companyId", "companyName", "continuousMileRateStr", "totalMile"],
    fieldAliases: { vehicleId: "carId", plate: "certId", enterpriseId: "companyId", enterpriseName: "companyName", totalMileage: "totalMile", completeness: "continuousMileRateStr" },
    fieldSignature: "d5bd6a9cebcb7bc198d45dda7839abb24baa97d1bd15880e9da1d9f6d085313d",
  }),
});

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
