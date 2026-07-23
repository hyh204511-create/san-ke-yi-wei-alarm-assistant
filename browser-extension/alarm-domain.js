const EVENT_RULES = new Set(["realtime-alarms", "pending-alarms", "prewarning-alarms", "prewarning-query", "alarm-query", "alarm-details", "technical-alarms"]);
const MAX_RECENT_CAPTURE_REFS = 20;
const COMPLETION_FIELDS = new Set([
  "platformStatus", "alarmStatus", "alarmCompleteStatus", "dealFlag", "dispositionFlag",
  "ignoreStatus", "verificationStatus", "evidenceAuditStatus", "appealResult", "positiveReportingFlag"
]);
const REMINDER_CATEGORIES = new Set(["DRIVER_IMMEDIATE", "DRIVER_CORRECTION", "INTERNAL_CONFIRMATION", "HIGH_RISK_INTERNAL"]);
const DRIVER_REMINDER_MODES = new Set(["VOICE_REQUIRED", "VOICE_PREFERRED", "TEXT_ONLY", "INTERNAL_ONLY", "VOICE_OR_TEXT_PENDING"]);
const SECONDARY_CHANNEL_MODES = new Set(["NONE", "ON_PRIMARY_FAILURE", "AFTER_PRIMARY_SUCCESS", "MANUAL_ONLY"]);
const COMPLETION_SOURCES = new Set(["PLATFORM_STATUS", "MANUAL_CONFIRMATION"]);
const PLATFORM_STATUS_FIELDS = new Set([
  "platformStatus", "alarmStatus", "alarmCompleteStatus", "dealFlag", "dispositionFlag",
  "ignoreStatus", "verificationStatus", "evidenceAuditStatus", "appealResult", "positiveReportingFlag", "onlineStatus"
]);

const SOURCE_META = {
  "realtime-alarms": { kind: "REALTIME", label: "实时报警（正式报警）", priority: 4 },
  "technical-alarms": { kind: "TECHNICAL", label: "技术检测报警", priority: 3 },
  "pending-alarms": { kind: "PENDING", label: "待处理正式报警", priority: 2 },
  "prewarning-alarms": { kind: "PENDING", label: "待处理正式报警", priority: 2 },
  "prewarning-query": { kind: "PREWARNING", label: "预报警（实时抓取）", priority: 1 },
  "alarm-query": { kind: "HISTORY", label: "报警查询/历史记录", priority: 0 },
  "alarm-details": { kind: "DETAIL", label: "报警详情", priority: 0 }
};

export function alarmSourceMeta(endpoint) {
  return SOURCE_META[endpoint] || { kind: "OTHER", label: "其他来源", priority: 0 };
}

export function alarmSourcePriority(event) {
  return Number(event?.sourcePriority ?? alarmSourceMeta(event?.rawEndpoint).priority);
}

export function alarmEventTime(event) {
  const value = event?.alarmTime || event?.updatedAt || event?.discoveredAt;
  const text = String(value || "");
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function alarmObservationTime(event) {
  const parsed = Date.parse(String(event?.updatedAt || event?.discoveredAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareAlarmOrder(left, right) {
  return Number(right?.priority || 0) - Number(left?.priority || 0)
    || Number(right?.time || 0) - Number(left?.time || 0);
}

export function selectLatestEligibleSpeedingPrewarning(items, nowMs = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  const candidates = (items || []).filter((item) => {
    const event = item?.event;
    const eventTime = alarmEventTime(event);
    return event?.sourceKind === "PREWARNING"
      && String(event?.alarmName || "").trim() === "超速驾驶"
      && /^\d{10,30}$/.test(String(event?.alarmId || ""))
      && Boolean(event?.vehicleId && event?.vehicleNo)
      && event?.certColor !== null && event?.certColor !== undefined && event?.certColor !== ""
      && event?.automaticPromotion !== true
      && !item?.action
      && item?.processing?.status !== "PROCESSED"
      && eventTime > 0 && eventTime <= nowMs + 60_000 && nowMs - eventTime <= maxAgeMs;
  });
  candidates.sort((left, right) => alarmEventTime(right.event) - alarmEventTime(left.event)
    || String(right.event.eventId).localeCompare(String(left.event.eventId)));
  return candidates[0] || null;
}

export function selectNextEligibleAutomaticAlarm(
  items,
  nowMs = Date.now(),
  maxAgeMs = 10 * 60 * 1000,
  prewarningObservationMaxAgeMs = 30_000
) {
  const candidates = (items || []).filter((item) => {
    const event = item?.event;
    const eventTime = alarmEventTime(event);
    const observationTime = alarmObservationTime(event);
    const formal = ["REALTIME", "PENDING"].includes(event?.sourceKind);
    const approvedPrewarning = event?.sourceKind === "PREWARNING"
      && String(event?.alarmName || "").trim() === "超速驾驶"
      && observationTime > 0
      && observationTime <= nowMs + 60_000
      && nowMs - observationTime <= prewarningObservationMaxAgeMs;
    return (formal || approvedPrewarning)
      && item?.decision?.action === "RESPONSE_PLAN"
      && /^\d{10,30}$/.test(String(event?.alarmId || ""))
      && Boolean(event?.vehicleId && event?.vehicleNo)
      && event?.certColor !== null && event?.certColor !== undefined && event?.certColor !== ""
      && event?.automaticPromotion !== true
      && !item?.action
      && [null, undefined, "", "UNPROCESSED"].includes(item?.processing?.status)
      && eventTime > 0 && eventTime <= nowMs + 60_000 && nowMs - eventTime <= maxAgeMs;
  });
  candidates.sort((left, right) => {
    const leftFallback = left.event.sourceKind === "PREWARNING" ? 1 : 0;
    const rightFallback = right.event.sourceKind === "PREWARNING" ? 1 : 0;
    return leftFallback - rightFallback
      || alarmEventTime(right.event) - alarmEventTime(left.event)
      || String(right.event.eventId).localeCompare(String(left.event.eventId));
  });
  return candidates[0] || null;
}

const ALIASES = {
  alarmId: ["alarmRecordId", "alarmInfoId", "recordId", "eventId", "id"],
  alarmTypeId: ["alarmTypeId", "alarmKind", "alarmCode", "alarmTypeCode"],
  alarmName: ["alarmName", "alarmTypeName", "alarmType", "typeName"],
  alarmTime: ["alarmTime", "startTime", "happenTime", "createTime", "warnTime"],
  vehicleId: ["carId", "vehicleId", "vid"],
  vehicleNo: ["certId", "vehicleNo", "plateNo", "carNo", "vehiclePlate"],
  certColor: ["certColor", "plateColor", "vehicleColor"],
  certColorName: ["certColorName", "plateColorName", "vehicleColorName"],
  vehicleType: ["vehicleTypeName", "carTypeName", "vehicleType", "carType"],
  driverName: ["driverName", "driver", "driverUserName"],
  companyId: ["companyId", "groupId", "enterpriseId", "ownerId"],
  companyName: ["companyName", "groupName", "enterpriseName", "ownerName"],
  location: ["location", "posDesc", "endPosDesc", "address", "position", "alarmAddress"],
  locationSpeed: ["locationSpeed", "gpsSpeed", "speed"],
  pulseSpeed: ["pulseSpeed", "canSpeed"],
  platformStatus: ["alarmCompleteStatusName", "alarmStatusName", "statusName", "dealStatusName", "auditStatusName", "status"],
  onlineStatus: ["onlineStatus", "vehicleOnlineStatus", "carOnlineStatus"]
};

// Technical detection responses contain useful diagnostics that are not part
// of the common alarm fields. Keep an explicit, non-sensitive allowlist so the
// event detail view can explain the problem without retaining contact data or
// evidence URLs from the raw response.
const TECHNICAL_DETAIL_FIELDS = [
  "alarmClassification", "alarmCompleteStatusName", "alarmTimeEnd", "certColorName",
  "dealFlag", "dealResult", "detail", "firmwareVersion", "recorderSpeed",
  "speed", "statusName", "sysType", "termAlarmno", "traceno",
  "vehicleModelType", "vehicleModelTypeName", "alarmWaitingDuration"
];

function firstValue(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return null;
}

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coordinateLocation(row) {
  const latitude = numberOrNull(firstValue(row, ["marsLat", "lat", "endMarsLat", "endLat"]));
  const longitude = numberOrNull(firstValue(row, ["marsLon", "lon", "endMarsLon", "endLon"]));
  if (latitude === null || longitude === null || latitude === 0 && longitude === 0) return null;
  return `坐标 ${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function looksLikeRecordId(value) {
  return /^\d{16,}$/.test(String(value ?? ""));
}

function technicalDetails(row, capture) {
  if (capture?.matchedRule !== "technical-alarms") return null;
  const details = Object.fromEntries(TECHNICAL_DETAIL_FIELDS
    .map((field) => [field, row?.[field]])
    .filter(([, value]) => value !== null && value !== undefined && value !== ""));
  return Object.keys(details).length ? details : null;
}

function findRows(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (typeof value !== "object") return [];
  for (const key of ["data", "rows", "list", "records", "items", "result", "content"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter((item) => item && typeof item === "object");
    if (nested && typeof nested === "object") {
      const rows = findRows(nested, depth + 1);
      if (rows.length) return rows;
    }
  }
  return [value];
}

export function extractAlarmCandidates(capture) {
  if (!EVENT_RULES.has(capture?.matchedRule)) return [];
  return findRows(capture.response?.body).filter((row) => {
    const keys = Object.keys(row);
    return keys.some((key) => /alarm|warn|certId|carId|vehicle/i.test(key));
  });
}

export function normalizeAlarmRow(row, capture) {
  const rawAlarmId = firstValue(row, ["alarmId"]);
  const explicitRecordId = firstValue(row, ALIASES.alarmId);
  const alarmId = text(explicitRecordId ?? (looksLikeRecordId(rawAlarmId) ? rawAlarmId : null));
  const alarmTypeId = text(firstValue(row, ALIASES.alarmTypeId) ?? (!looksLikeRecordId(rawAlarmId) ? rawAlarmId : null));
  const normalized = {
    alarmId,
    alarmTypeId,
    alarmName: text(firstValue(row, ALIASES.alarmName)),
    alarmTime: text(firstValue(row, ALIASES.alarmTime)),
    vehicleId: text(firstValue(row, ALIASES.vehicleId)),
    vehicleNo: text(firstValue(row, ALIASES.vehicleNo)),
    certColor: text(firstValue(row, ALIASES.certColor)),
    certColorName: text(firstValue(row, ALIASES.certColorName)),
    vehicleType: text(firstValue(row, ALIASES.vehicleType)),
    driverName: text(firstValue(row, ALIASES.driverName)),
    companyId: text(firstValue(row, ALIASES.companyId)),
    companyName: text(firstValue(row, ALIASES.companyName)),
    location: text(firstValue(row, ALIASES.location)) || coordinateLocation(row),
    locationSpeed: numberOrNull(firstValue(row, ALIASES.locationSpeed)),
    pulseSpeed: numberOrNull(firstValue(row, ALIASES.pulseSpeed)),
    platformStatus: text(firstValue(row, ALIASES.platformStatus)),
    onlineStatus: text(firstValue(row, ALIASES.onlineStatus)),
    alarmStatus: text(row?.alarmStatus),
    alarmCompleteStatus: text(row?.alarmCompleteStatus),
    dealFlag: text(row?.dealFlag),
    dispositionFlag: text(row?.dispositionFlag),
    ignoreStatus: text(row?.ignoreStatus),
    verificationStatus: text(row?.verificationStatus),
    evidenceAuditStatus: text(row?.evidenceAuditStatus),
    appealResult: text(row?.appealResult),
    positiveReportingFlag: text(row?.positiveReportingFLag ?? row?.positiveReportingFlag),
    technicalDetails: technicalDetails(row, capture)
  };
  const identity = normalized.alarmId || [
    normalized.vehicleId || normalized.vehicleNo,
    normalized.alarmTypeId || normalized.alarmName,
    normalized.alarmTime
  ].map((item) => item || "?").join("|");
  if (!normalized.alarmId && identity.includes("?")) normalized.identityWeak = true;
  const source = alarmSourceMeta(capture.matchedRule);
  return {
    ...normalized,
    eventId: normalized.alarmId ? `alarm:id:${normalized.alarmId}` : `alarm:weak:${stableHash(identity)}`,
    state: "DISCOVERED",
    discoveredAt: capture.capturedAt,
    updatedAt: capture.capturedAt,
    sourceCaptures: [capture.captureId],
    sourceCaptureCount: 1,
    sources: Object.fromEntries(Object.entries(normalized)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([field]) => [field, [{
        captureId: capture.captureId,
        endpoint: capture.matchedRule,
        capturedAt: capture.capturedAt,
        firstCaptureId: capture.captureId,
        firstCapturedAt: capture.capturedAt,
        lastCaptureId: capture.captureId,
        lastCapturedAt: capture.capturedAt,
        occurrences: 1,
      }]])),
    conflicts: {},
    notes: [],
    rawEndpoint: capture.matchedRule,
    sourceKind: source.kind,
    sourceLabel: source.label,
    sourcePriority: source.priority,
    sourceEndpoints: [capture.matchedRule]
  };
}

export function mergeAlarmEvents(existing, incoming) {
  if (!existing) return { ...incoming, state: "READY" };
  const merged = structuredClone(existing);
  const ignored = new Set(["eventId", "state", "discoveredAt", "updatedAt", "sourceCaptures", "sourceCaptureCount", "sources", "conflicts", "notes", "rawEndpoint", "sourceKind", "sourceLabel", "sourcePriority", "sourceEndpoints"]);
  delete merged.conflicts?.discoveredAt;
  delete merged.conflicts?.updatedAt;
  for (const [field, value] of Object.entries(incoming)) {
    if (ignored.has(field) || value === null || value === undefined || value === "") continue;
    if (field === "technicalDetails" && value && typeof value === "object" && !Array.isArray(value)) {
      merged[field] = { ...(merged[field] || {}), ...value };
      continue;
    }
    const current = merged[field];
    if (current !== null && current !== undefined && current !== "" && String(current) !== String(value)) {
      if (PLATFORM_STATUS_FIELDS.has(field)) {
        merged.statusTransitions = [
          ...(merged.statusTransitions || []),
          { field, from: String(current), to: String(value), observedAt: incoming.updatedAt || incoming.discoveredAt || new Date().toISOString() },
        ].slice(-50);
        merged[field] = value;
        continue;
      }
      const values = new Set([...(merged.conflicts?.[field] || []), String(current), String(value)]);
      merged.conflicts[field] = [...values];
      continue;
    }
    merged[field] = value;
  }
  merged.updatedAt = incoming.updatedAt;
  merged.state = "READY";
  const existingCaptureRefs = existing.sourceCaptures || [];
  const incomingCaptureRefs = incoming.sourceCaptures || [];
  const existingCaptureSet = new Set(existingCaptureRefs);
  const newCaptureRefs = incomingCaptureRefs.filter((captureId) => !existingCaptureSet.has(captureId));
  merged.sourceCaptureCount = Number(existing.sourceCaptureCount || existingCaptureRefs.length) + newCaptureRefs.length;
  merged.sourceCaptures = [...new Set([...existingCaptureRefs, ...incomingCaptureRefs])].slice(-MAX_RECENT_CAPTURE_REFS);
  merged.sourceEndpoints = [...new Set([
    ...(existing.sourceEndpoints || [existing.rawEndpoint].filter(Boolean)),
    ...(incoming.sourceEndpoints || [incoming.rawEndpoint].filter(Boolean))
  ])];
  if (alarmSourcePriority(incoming) > alarmSourcePriority(existing)) {
    merged.rawEndpoint = incoming.rawEndpoint;
    merged.sourceKind = incoming.sourceKind;
    merged.sourceLabel = incoming.sourceLabel;
    merged.sourcePriority = incoming.sourcePriority;
  } else {
    const existingSource = alarmSourceMeta(existing.rawEndpoint);
    merged.sourceKind ||= existingSource.kind;
    merged.sourceLabel ||= existingSource.label;
    merged.sourcePriority ??= existingSource.priority;
  }
  for (const [field, sources] of Object.entries(incoming.sources || {})) {
    const byEndpoint = new Map();
    for (const item of [...(merged.sources[field] || []), ...sources]) {
      const key = item.endpoint || item.captureId;
      const current = byEndpoint.get(key);
      if (!current) {
        byEndpoint.set(key, {
          ...item,
          firstCaptureId: item.firstCaptureId || item.captureId,
          firstCapturedAt: item.firstCapturedAt || item.capturedAt,
          lastCaptureId: item.lastCaptureId || item.captureId,
          lastCapturedAt: item.lastCapturedAt || item.capturedAt,
          occurrences: Number(item.occurrences || 1),
        });
        continue;
      }
      const itemFirstAt = item.firstCapturedAt || item.capturedAt;
      const itemLastAt = item.lastCapturedAt || item.capturedAt;
      if (itemFirstAt && (!current.firstCapturedAt || itemFirstAt < current.firstCapturedAt)) {
        current.firstCapturedAt = itemFirstAt;
        current.firstCaptureId = item.firstCaptureId || item.captureId;
      }
      if (itemLastAt && (!current.lastCapturedAt || itemLastAt >= current.lastCapturedAt)) {
        current.lastCapturedAt = itemLastAt;
        current.lastCaptureId = item.lastCaptureId || item.captureId;
        current.captureId = item.lastCaptureId || item.captureId;
        current.capturedAt = itemLastAt;
      }
      current.occurrences += Number(item.occurrences || 1);
    }
    merged.sources[field] = [...byEndpoint.values()];
  }
  return merged;
}

function normalizedScopeValue(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

export function enterpriseAccessForEvent(event, enterpriseScopes = []) {
  if (!Array.isArray(enterpriseScopes) || !enterpriseScopes.length) {
    return { status: "NO_SCOPE", matchedEnterpriseId: null };
  }
  const companyId = normalizedScopeValue(event?.companyId);
  const companyName = normalizedScopeValue(event?.companyName);
  if (!companyId && !companyName) {
    return { status: "UNRESOLVED", matchedEnterpriseId: null };
  }
  for (const scope of enterpriseScopes) {
    const codes = [scope?.enterpriseCode, scope?.platformEnterpriseId, scope?.enterpriseId]
      .map(normalizedScopeValue).filter(Boolean);
    const names = [scope?.enterpriseName, ...(scope?.enterpriseAliases || [])]
      .map(normalizedScopeValue).filter(Boolean);
    if (companyId && codes.includes(companyId) || companyName && names.includes(companyName)) {
      return { status: "ALLOWED", matchedEnterpriseId: scope.enterpriseId || null };
    }
  }
  return { status: "OUT_OF_SCOPE", matchedEnterpriseId: null };
}

export function validateRuleSet(ruleSet, audioAssets = {}) {
  const errors = [];
  if (!ruleSet || typeof ruleSet !== "object") return { ok: false, errors: ["规则集必须是对象"] };
  if (ruleSet.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (typeof ruleSet.version !== "string" || !ruleSet.version.trim() || ruleSet.version.length > 100) errors.push("规则集版本无效");
  if (!Array.isArray(ruleSet.rules)) errors.push("rules 必须是数组");
  if (Array.isArray(ruleSet.rules) && ruleSet.rules.length > 500) errors.push("单个规则集最多包含500条规则");
  const ids = new Set();
  const confirmedConditions = new Map();
  const arrayFields = ["alarmTypeIds", "alarmNames", "alarmAliases", "vehicleTypes", "companyIds", "companyNames"];
  const validClock = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  for (const [index, rule] of (ruleSet.rules || []).entries()) {
    const prefix = `rules[${index}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push(`${prefix} 必须是对象`);
      continue;
    }
    if (typeof rule.id !== "string" || !rule.id.trim() || rule.id.length > 100) errors.push(`${prefix} id 无效`);
    else if (ids.has(rule.id)) errors.push(`${prefix} id 重复: ${rule.id}`);
    else ids.add(rule.id);
    if (typeof rule.enabled !== "boolean") errors.push(`${prefix} enabled 必须是布尔值`);
    if (!["PENDING", "PENDING_CONFIRMATION", "CONFIRMED", "REJECTED"].includes(rule.approvalStatus)) errors.push(`${prefix} approvalStatus 无效`);
    if (!Number.isFinite(Number(rule.priority))) errors.push(`${prefix} priority 必须是数字`);
    if (!["AUTO_VOICE", "MANUAL_REVIEW", "RECORD_ONLY", "DISABLED"].includes(rule.action)) errors.push(`${prefix} action 无效`);
    const match = rule.match;
    if (!match || typeof match !== "object" || Array.isArray(match)) errors.push(`${prefix} match 必须是对象`);
    for (const field of arrayFields) {
      if (match?.[field] !== undefined && (!Array.isArray(match[field]) || match[field].some((value) => !["string", "number"].includes(typeof value) || !String(value).trim()))) {
        errors.push(`${prefix} match.${field} 必须是非空字符串或数字数组`);
      }
    }
    if (match?.timeRanges !== undefined && (!Array.isArray(match.timeRanges) || match.timeRanges.some((range) => !range || !validClock(range.start) || !validClock(range.end)))) {
      errors.push(`${prefix} match.timeRanges 必须包含有效的 HH:mm 起止时间`);
    }
    if (match?.risks !== undefined && (!Array.isArray(match.risks) || match.risks.length)) {
      errors.push(`${prefix} match.risks 当前尚未定义安全的运行时语义，请暂时留空`);
    }
    if (rule.action === "AUTO_VOICE") {
      if (!rule.voiceTemplateId) errors.push(`${prefix} 自动语音缺少 voiceTemplateId`);
      if (!rule.audioAssetId) errors.push(`${prefix} 自动语音缺少 audioAssetId`);
      if (rule.audioAssetId && !audioAssets[rule.audioAssetId]) errors.push(`${prefix} 引用的音频不存在: ${rule.audioAssetId}`);
      if (rule.approvalStatus === "CONFIRMED" && rule.audioAssetId && !audioAssets[rule.audioAssetId]?.confirmed) errors.push(`${prefix} 已确认规则只能引用已确认音频`);
    }
    if (rule.allowRealIntercom === true && rule.approvalStatus !== "CONFIRMED") errors.push(`${prefix} 未确认规则不得允许真实对讲`);
    if (rule.enabled && rule.action !== "DISABLED" && rule.approvalStatus === "CONFIRMED" && match && typeof match === "object") {
      const canonical = JSON.stringify({
        priority: Number(rule.priority || 0),
        match: Object.fromEntries([...arrayFields, "timeRanges"].map((field) => [field, match[field] || []]))
      });
      if (confirmedConditions.has(canonical)) errors.push(`${prefix} 与已确认规则 ${confirmedConditions.get(canonical)} 条件及优先级冲突`);
      else confirmedConditions.set(canonical, rule.id || prefix);
    }
  }
  return { ok: errors.length === 0, errors };
}

function runtimeAssetMap(responseAssets) {
  if (Array.isArray(responseAssets)) return Object.fromEntries(responseAssets.map((asset) => [asset.assetKey, asset]));
  return responseAssets && typeof responseAssets === "object" ? responseAssets : {};
}

export async function validateRuntimeRuleSet(ruleSet, responseAssets = {}) {
  if (ruleSet?.schemaVersion === 1) return validateRuleSet(ruleSet, responseAssets);
  const errors = [];
  const assets = runtimeAssetMap(responseAssets);
  if (!ruleSet || typeof ruleSet !== "object" || ruleSet.schemaVersion !== 2) return { ok: false, errors: ["运行规则schemaVersion必须为2"] };
  if (ruleSet.status !== "PUBLISHED") errors.push("运行规则必须是已发布版本");
  if (typeof ruleSet.version !== "string" || !ruleSet.version || ruleSet.version.length > 100) errors.push("运行规则版本无效");
  if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length > 500) errors.push("运行规则rules无效或超过500条");
  const ids = new Set();
  for (const [index, rule] of (ruleSet.rules || []).entries()) {
    const prefix = `rules[${index}]`;
    if (!rule || typeof rule !== "object") { errors.push(`${prefix}必须是对象`); continue; }
    if (typeof rule.id !== "string" || !rule.id || ids.has(rule.id)) errors.push(`${prefix}.id无效或重复`); else ids.add(rule.id);
    if (typeof rule.enabled !== "boolean") errors.push(`${prefix}.enabled必须是布尔值`);
    if (!Number.isFinite(Number(rule.priority))) errors.push(`${prefix}.priority必须是数字`);
    if (!["AUTO", "MANUAL", "RECORD_ONLY", "DISABLED"].includes(rule.handlingMode)) errors.push(`${prefix}.handlingMode无效`);
    if (!rule.match || typeof rule.match !== "object" || Array.isArray(rule.match)) errors.push(`${prefix}.match必须是对象`);
    if (rule.match?.sourceKinds !== undefined && (!Array.isArray(rule.match.sourceKinds) || rule.match.sourceKinds.some((kind) => !["REALTIME", "TECHNICAL", "PENDING", "PREWARNING", "HISTORY", "DETAIL"].includes(kind)))) errors.push(`${prefix}.match.sourceKinds无效`);
    const channels = rule.channels || [];
    if (!Array.isArray(channels)) { errors.push(`${prefix}.channels必须是数组`); continue; }
    const reminderPolicy = reminderPolicyForRule(rule);
    if (!REMINDER_CATEGORIES.has(reminderPolicy.category)) errors.push(`${prefix}.reminderPolicy.category无效`);
    if (!DRIVER_REMINDER_MODES.has(reminderPolicy.driverReminder)) errors.push(`${prefix}.reminderPolicy.driverReminder无效`);
    if (!SECONDARY_CHANNEL_MODES.has(reminderPolicy.secondaryChannelMode)) errors.push(`${prefix}.reminderPolicy.secondaryChannelMode无效`);
    const completion = reminderPolicy.completion;
    if (!completion || !COMPLETION_SOURCES.has(completion.source)) errors.push(`${prefix}.reminderPolicy.completion.source无效`);
    if (completion && (!Array.isArray(completion.fields) || completion.fields.some((field) => !COMPLETION_FIELDS.has(field)))) errors.push(`${prefix}.reminderPolicy.completion.fields无效`);
    if (completion && (!completion.clearedValues || typeof completion.clearedValues !== "object" || Array.isArray(completion.clearedValues))) errors.push(`${prefix}.reminderPolicy.completion.clearedValues必须是字段到值数组的对象`);
    if (completion && completion.clearedValues && typeof completion.clearedValues === "object" && !Array.isArray(completion.clearedValues)) {
      for (const [field, values] of Object.entries(completion.clearedValues)) {
        if (!COMPLETION_FIELDS.has(field) || !Array.isArray(values) || values.some((value) => ["string", "number", "boolean"].indexOf(typeof value) === -1)) errors.push(`${prefix}.reminderPolicy.completion.clearedValues无效: ${field}`);
      }
    }
    if (completion && completion.unknownAction !== "MANUAL_REVIEW") errors.push(`${prefix}.reminderPolicy.completion.unknownAction必须为MANUAL_REVIEW`);
    if (rule.handlingMode === "AUTO" && !channels.length) errors.push(`${prefix}自动规则必须配置响应渠道`);
    if (rule.handlingMode === "AUTO" && (channels.length < 1 || channels.length > 2 || channels.some((channel) => !["TEXT", "VOICE"].includes(channel?.type)))) {
      errors.push(`${prefix}自动规则必须配置一个主渠道，可选一个明确的文本补充/兜底渠道`);
    }
    if (rule.handlingMode !== "AUTO" && reminderPolicy.driverReminder === "INTERNAL_ONLY" && channels.length) {
      errors.push(`${prefix}内部确认规则不能配置司机提醒渠道`);
    }
    if (rule.handlingMode === "AUTO" && ["INTERNAL_ONLY", "VOICE_OR_TEXT_PENDING"].includes(reminderPolicy.driverReminder)) {
      errors.push(`${prefix}当前提醒策略不能自动向司机发送`);
    }
    if (rule.handlingMode === "AUTO" && reminderPolicy.driverReminder === "VOICE_REQUIRED" && channels[0]?.type !== "VOICE") errors.push(`${prefix}VOICE_REQUIRED主渠道必须为VOICE`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.driverReminder === "VOICE_PREFERRED" && channels[0]?.type !== "VOICE") errors.push(`${prefix}VOICE_PREFERRED主渠道必须为VOICE`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.driverReminder === "TEXT_ONLY" && channels[0]?.type !== "TEXT") errors.push(`${prefix}TEXT_ONLY主渠道必须为TEXT`);
    const sourceKinds = rule.match?.sourceKinds || [];
    const prewarningAuto = rule.handlingMode === "AUTO" && sourceKinds.includes("PREWARNING");
    if (rule.handlingMode === "AUTO" && sourceKinds.some((kind) => ["HISTORY", "DETAIL"].includes(kind))) {
      errors.push(`${prefix}历史和详情来源不能触发自动响应`);
    }
    const strategy = rule.channelStrategy || (channels.length <= 1 ? "SINGLE" : null);
    if (!["SINGLE", "SEQUENTIAL", "FALLBACK", "PARALLEL"].includes(strategy)) errors.push(`${prefix}.channelStrategy无效`);
    if (channels.length > 1 && strategy === "SINGLE") errors.push(`${prefix}多渠道不能使用SINGLE策略`);
    if (rule.handlingMode === "AUTO" && channels.length === 1 && strategy !== "SINGLE") errors.push(`${prefix}单渠道自动规则必须使用SINGLE策略`);
    if (rule.handlingMode === "AUTO" && channels.length === 2 && !["FALLBACK", "SEQUENTIAL"].includes(strategy)) errors.push(`${prefix}双渠道自动规则必须使用FALLBACK或SEQUENTIAL策略`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.secondaryChannelMode === "NONE" && channels.length !== 1) errors.push(`${prefix}secondaryChannelMode为NONE时不得配置第二渠道`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.secondaryChannelMode === "ON_PRIMARY_FAILURE" && (channels.length !== 2 || strategy !== "FALLBACK")) errors.push(`${prefix}失败兜底必须配置双渠道FALLBACK`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.secondaryChannelMode === "AFTER_PRIMARY_SUCCESS" && (channels.length !== 2 || strategy !== "SEQUENTIAL")) errors.push(`${prefix}成功后补充必须配置双渠道SEQUENTIAL`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.secondaryChannelMode === "MANUAL_ONLY" && channels.length !== 1) errors.push(`${prefix}人工补充模式不得自动配置第二渠道`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.secondaryChannelMode === "ON_PRIMARY_FAILURE" && channels[0]?.type !== "VOICE") errors.push(`${prefix}当前失败兜底策略的主渠道必须为VOICE`);
    if (rule.handlingMode === "AUTO" && reminderPolicy.secondaryChannelMode === "ON_PRIMARY_FAILURE" && channels[1]?.type !== "TEXT") errors.push(`${prefix}当前失败兜底策略的第二渠道必须为TEXT_TTS`);
    if (prewarningAuto) {
      const alarmNames = rule.match?.alarmNames || [];
      const fixedChannels = channels.map((channel) => channel?.type).join(",") === "VOICE,TEXT";
      const fixedAssets = channels[0]?.assetId === "voice-speeding-v1" && channels[1]?.templateId === "text-speeding-v1";
      if (JSON.stringify(sourceKinds) !== JSON.stringify(["PREWARNING"]) || JSON.stringify(alarmNames) !== JSON.stringify(["超速驾驶"])) {
        errors.push(`${prefix}当前仅允许显式PREWARNING来源的超速驾驶自动规则`);
      }
      if (!fixedChannels || !fixedAssets || strategy !== "SEQUENTIAL" || rule.fallback !== "TEXT_ON_VOICE_FAILURE") {
        errors.push(`${prefix}超速预报警必须固定为已审核语音后文本顺序流程`);
      }
    } else if (rule.fallback === "TEXT_ON_VOICE_FAILURE") {
      errors.push(`${prefix}.fallback仅允许已审核超速预报警规则使用`);
    }
    const orders = new Set();
    for (const [channelIndex, channel] of channels.entries()) {
      const channelPrefix = `${prefix}.channels[${channelIndex}]`;
      if (!channel || !["TEXT", "VOICE"].includes(channel.type)) { errors.push(`${channelPrefix}.type无效`); continue; }
      if (!Number.isInteger(channel.order) || channel.order < 1 || orders.has(channel.order)) errors.push(`${channelPrefix}.order无效或重复`); else orders.add(channel.order);
      if (!channel.recipientType) errors.push(`${channelPrefix}.recipientType缺失`);
      if (channel.type === "TEXT" && channel.terminalTts !== true && rule.handlingMode === "AUTO") {
        errors.push(`${channelPrefix}.terminalTts必须为true`);
      }
      if (channel.type === "VOICE" && rule.handlingMode === "AUTO" && channel.terminalTts === true) {
        errors.push(`${channelPrefix}VOICE渠道不能同时设置terminalTts`);
      }
      if (channel.type === "VOICE" && (typeof channel.spokenTemplate !== "string" || !channel.spokenTemplate.trim() || channel.spokenTemplate.length > 500)) {
        errors.push(`${channelPrefix}.spokenTemplate必须为1至500字符`);
      }
      const key = channel.type === "TEXT" ? channel.templateId : channel.assetId;
      const asset = assets[key];
      if (!key || !asset || asset.channelType !== channel.type) errors.push(`${channelPrefix}引用的已发布资产不存在或类型不匹配: ${key || "空"}`);
    }
    const retryPolicy = rule.retryPolicy;
    if (rule.handlingMode === "AUTO" && (!retryPolicy || retryPolicy.maxRetries !== 2
      || JSON.stringify(retryPolicy.delaysMs) !== JSON.stringify([5000, 10000])
      || JSON.stringify(retryPolicy.retryOn) !== JSON.stringify(["FAILED"])
      || retryPolicy.maxDurationMs !== 30000)) {
      errors.push(`${prefix}.retryPolicy必须固定为明确失败后5秒、10秒重试，30秒内转人工`);
    }
  }
  for (const asset of Object.values(assets)) {
    try {
      const material = asset.channelType === "TEXT"
        ? new TextEncoder().encode(`TEXT\0${asset.textTemplate || ""}`)
        : Uint8Array.from(atob(asset.voiceBase64 || ""), (char) => char.charCodeAt(0));
      let bytes = material;
      if (asset.channelType === "VOICE") {
        const prefix = new TextEncoder().encode("VOICE\0");
        bytes = new Uint8Array(prefix.length + material.length);
        bytes.set(prefix, 0);
        bytes.set(material, prefix.length);
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (actual !== String(asset.contentHash || "").toLowerCase()) errors.push(`响应资产哈希不匹配: ${asset.assetKey}`);
    } catch {
      errors.push(`响应资产内容无效: ${asset.assetKey || "未知"}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function validateAudioAsset(asset) {
  const errors = [];
  if (!asset || typeof asset !== "object") return { ok: false, errors: ["音频资产必须是对象"] };
  if (typeof asset.id !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(asset.id)) errors.push("音频资产ID只能包含字母、数字、点、下划线和连字符");
  if (asset.sampleRate !== 8000 || asset.channels !== 1 || asset.bitsPerSample !== 16) errors.push("音频必须是8kHz、16bit、单声道PCM/WAV");
  if (typeof asset.pcmBase64 !== "string" || !asset.pcmBase64 || asset.pcmBase64.length > 1_300_000) errors.push("PCM数据为空或超过60秒限制");
  let bytes = null;
  if (!errors.length) {
    try {
      const binary = atob(asset.pcmBase64);
      bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      errors.push("PCM数据不是有效Base64");
    }
  }
  if (bytes && (!bytes.length || bytes.length % 2 !== 0 || bytes.length > 8000 * 2 * 60)) errors.push("PCM采样长度无效或超过60秒限制");
  const expectedDuration = bytes ? Math.round(bytes.length / 2 / 8000 * 1000) : null;
  if (bytes && (!Number.isFinite(asset.durationMs) || asset.durationMs !== expectedDuration)) errors.push("音频时长与PCM数据不一致");
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    errors.push("音频SHA-256无效");
  } else if (bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (actual !== asset.sha256.toLowerCase()) errors.push("音频SHA-256与PCM数据不一致");
  }
  return { ok: errors.length === 0, errors };
}

export function extractPcmFromWav(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) throw new Error("固定语音资产不是有效WAV");
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("固定语音资产不是有效WAV");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = null;
  let pcm = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkId = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) throw new Error("固定语音WAV区块长度无效");
    if (chunkId === "fmt " && size >= 16) {
      format = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bitsPerSample: view.getUint16(start + 14, true),
      };
    } else if (chunkId === "data") {
      pcm = bytes.slice(start, end);
    }
    offset = end + (size % 2);
  }
  if (!format || !pcm || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 8000 || format.bitsPerSample !== 16) {
    throw new Error("固定语音WAV必须是8kHz 16bit单声道PCM");
  }
  if (!pcm.length || pcm.length % 2 !== 0) throw new Error("固定语音PCM长度无效");
  return pcm;
}

function ruleSpecificity(rule) {
  const match = rule.match || {};
  return [match.companyIds, match.companyNames, match.vehicleTypes, match.timeRanges, match.risks]
    .reduce((count, value) => count + (Array.isArray(value) && value.length ? 1 : 0), 0);
}

function includesText(values, value) {
  return !Array.isArray(values) || values.length === 0 || (value != null && values.some((item) => String(item) === String(value)));
}

function nameMatches(match, value) {
  const names = [...(match.alarmNames || []), ...(match.alarmAliases || [])];
  return !names.length || (value && names.some((item) => String(item).trim() === String(value).trim()));
}

function timeMatches(ranges, alarmTime) {
  if (!Array.isArray(ranges) || !ranges.length) return true;
  if (!alarmTime) return false;
  const match = String(alarmTime).match(/(\d{2}):(\d{2})/);
  if (!match) return false;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return ranges.some(({ start, end }) => {
    if (typeof start !== "string" || typeof end !== "string") return false;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const from = sh * 60 + sm;
    const to = eh * 60 + em;
    return from <= to ? minutes >= from && minutes <= to : minutes >= from || minutes <= to;
  });
}

function defaultReminderPolicy(rule = {}) {
  const firstChannel = Array.isArray(rule.channels) ? rule.channels[0] : null;
  const driverReminder = firstChannel?.type === "VOICE"
    ? "VOICE_PREFERRED"
    : firstChannel?.type === "TEXT"
      ? "TEXT_ONLY"
      : "INTERNAL_ONLY";
  const category = driverReminder === "INTERNAL_ONLY" ? "INTERNAL_CONFIRMATION" : "DRIVER_CORRECTION";
  return {
    category,
    driverReminder,
    secondaryChannelMode: "NONE",
    completion: {
      source: "MANUAL_CONFIRMATION",
      fields: [],
      clearedValues: {},
      unknownAction: "MANUAL_REVIEW",
    },
  };
}

function reminderPolicyForRule(rule = {}) {
  const base = defaultReminderPolicy(rule);
  const configured = rule?.reminderPolicy || {};
  const legacyConfigured = {
    ...(rule?.driverReminder ? { driverReminder: rule.driverReminder } : {}),
    ...(rule?.secondaryChannelMode ? { secondaryChannelMode: rule.secondaryChannelMode } : {}),
  };
  return {
    ...base,
    ...legacyConfigured,
    ...structuredClone(configured),
    completion: { ...base.completion, ...(configured.completion || {}) },
  };
}

export function evaluateCompletion(event, ruleOrPolicy = {}) {
  const policy = ruleOrPolicy?.reminderPolicy || ruleOrPolicy?.responsePolicy || ruleOrPolicy || {};
  const completion = policy.completion || {};
  const fields = Array.isArray(completion.fields) ? completion.fields.filter((field) => COMPLETION_FIELDS.has(field)) : [];
  if (completion.source !== "PLATFORM_STATUS" || !fields.length) {
    return {
      status: "UNKNOWN_MANUAL",
      source: completion.source || "MANUAL_CONFIRMATION",
      reason: "没有足够的省平台状态字段或已配置的完成口径，必须人工确认",
      manualRequired: true,
      observedFields: [],
    };
  }
  const observedFields = fields
    .map((field) => ({ field, value: event?.[field] }))
    .filter(({ value }) => value !== null && value !== undefined && value !== "")
    .map(({ field, value }) => ({ field, value: String(value) }));
  if (!observedFields.length) {
    return {
      status: "UNKNOWN_MANUAL",
      source: "PLATFORM_STATUS",
      reason: "省平台未提供可用于完成判定的状态字段，必须人工确认",
      manualRequired: true,
      observedFields,
    };
  }
  const clearedValues = completion.clearedValues && typeof completion.clearedValues === "object"
    ? completion.clearedValues : {};
  const cleared = observedFields.find(({ field, value }) => Array.isArray(clearedValues[field]) && clearedValues[field].some((item) => String(item) === value));
  if (cleared) {
    return {
      status: "PLATFORM_CLEARED",
      source: "PLATFORM_STATUS",
      reason: `省平台字段 ${cleared.field} 已匹配已解除/已完成状态`,
      manualRequired: false,
      observedFields,
      matchedField: cleared.field,
      matchedValue: cleared.value,
    };
  }
  return {
    status: "PLATFORM_ACTIVE",
    source: "PLATFORM_STATUS",
    reason: "省平台仍提供报警状态，但未匹配已解除/已完成值；不由插件推断纠正结果",
    manualRequired: false,
    observedFields,
  };
}

export function evaluateRules(event, ruleSet) {
  if (event?.sourceKind === "HISTORY") {
    return decision(event, ruleSet, null, "RECORD_ONLY", "报警查询和历史记录只用于复盘、核验和报表，不触发实时响应");
  }
  if (event?.sourceKind === "PREWARNING") {
    if (ruleSet?.schemaVersion === 2 && ruleSet?.status === "PUBLISHED") {
      const publishedDecision = evaluateSchemaV2Rules(event, ruleSet);
      if (publishedDecision.action === "RESPONSE_PLAN") return publishedDecision;
    }
    return decision(event, ruleSet, null, "RECORD_ONLY", "预报警只有命中后台已发布且明确包含PREWARNING来源的规则时才执行真实动作");
  }
  if (event?.sourceKind === "DETAIL") {
    return decision(event, ruleSet, null, "RECORD_ONLY", "报警详情仅用于补齐字段和证据，不独立触发响应");
  }
  if (ruleSet?.schemaVersion === 2) return evaluateSchemaV2Rules(event, ruleSet);
  const candidates = (ruleSet?.rules || []).filter((rule) => {
    if (!rule.enabled || rule.approvalStatus !== "CONFIRMED" || rule.action === "DISABLED") return false;
    const match = rule.match || {};
    const idConfigured = Array.isArray(match.alarmTypeIds) && match.alarmTypeIds.length > 0;
    const nameConfigured = [...(match.alarmNames || []), ...(match.alarmAliases || [])].length > 0;
    if (idConfigured && !includesText(match.alarmTypeIds, event.alarmTypeId)) return false;
    if (!idConfigured && nameConfigured && !nameMatches(match, event.alarmName)) return false;
    return includesText(match.vehicleTypes, event.vehicleType)
      && includesText(match.companyIds, event.companyId)
      && includesText(match.companyNames, event.companyName)
      && timeMatches(match.timeRanges, event.alarmTime);
  }).map((rule) => ({
    rule,
    idExact: Array.isArray(rule.match?.alarmTypeIds) && rule.match.alarmTypeIds.some((id) => String(id) === String(event.alarmTypeId)),
    specificity: ruleSpecificity(rule),
    priority: Number(rule.priority || 0)
  })).sort((a, b) => Number(b.idExact) - Number(a.idExact) || b.specificity - a.specificity || b.priority - a.priority);

  const top = candidates[0];
  const tied = top && candidates.filter((item) => item.idExact === top.idExact && item.specificity === top.specificity && item.priority === top.priority);
  if (!top) return decision(event, ruleSet, null, "MANUAL_REVIEW", "没有匹配到已确认规则");
  if (tied.length > 1) return decision(event, ruleSet, null, "MANUAL_REVIEW", `规则冲突: ${tied.map((item) => item.rule.id).join(", ")}`);
  return decision(event, ruleSet, top.rule, top.rule.action, "规则匹配成功");
}

function evaluateSchemaV2Rules(event, ruleSet) {
  const candidates = (ruleSet?.rules || []).filter((rule) => {
    if (!rule.enabled || rule.handlingMode === "DISABLED") return false;
    const match = rule.match || {};
    if (event?.sourceKind === "PREWARNING" && !(Array.isArray(match.sourceKinds) && match.sourceKinds.includes("PREWARNING"))) return false;
    if (Array.isArray(match.sourceKinds) && match.sourceKinds.length && !match.sourceKinds.includes(event.sourceKind)) return false;
    const idConfigured = Array.isArray(match.alarmTypeIds) && match.alarmTypeIds.length > 0;
    const nameConfigured = [...(match.alarmNames || []), ...(match.alarmAliases || [])].length > 0;
    if (idConfigured && !includesText(match.alarmTypeIds, event.alarmTypeId)) return false;
    if (!idConfigured && nameConfigured && !nameMatches(match, event.alarmName)) return false;
    return includesText(match.vehicleTypes, event.vehicleType)
      && includesText(match.companyIds, event.companyId)
      && includesText(match.companyNames, event.companyName)
      && timeMatches(match.timeRanges, event.alarmTime);
  }).map((rule) => ({
    rule,
    idExact: Array.isArray(rule.match?.alarmTypeIds) && rule.match.alarmTypeIds.some((id) => String(id) === String(event.alarmTypeId)),
    specificity: ruleSpecificity(rule),
    priority: Number(rule.priority || 0)
  })).sort((a, b) => Number(b.idExact) - Number(a.idExact) || b.specificity - a.specificity || b.priority - a.priority);
  const top = candidates[0];
  const tied = top && candidates.filter((item) => item.idExact === top.idExact && item.specificity === top.specificity && item.priority === top.priority);
  if (!top) return decision(event, ruleSet, null, "MANUAL_REVIEW", "没有匹配到已发布规则");
  if (tied.length > 1) return decision(event, ruleSet, null, "MANUAL_REVIEW", `规则冲突: ${tied.map((item) => item.rule.id).join(", ")}`);
  const action = top.rule.handlingMode === "AUTO" ? "RESPONSE_PLAN"
    : top.rule.handlingMode === "RECORD_ONLY" ? "RECORD_ONLY"
      : "MANUAL_REVIEW";
  return decision(event, ruleSet, top.rule, action, "规则匹配成功");
}

function decision(event, ruleSet, rule, action, reason) {
  const decidedAt = new Date().toISOString();
  const reminderPolicy = rule ? reminderPolicyForRule(rule) : null;
  const automaticPromotion = event?.sourceKind === "PREWARNING" && action === "RESPONSE_PLAN";
  return {
    decisionId: `decision:${stableHash(`${event.eventId}|${ruleSet?.version || "none"}`)}`,
    eventId: event.eventId,
    ruleSetVersion: ruleSet?.version || null,
    ruleId: rule?.id || null,
    action,
    reason,
    automaticPromotion,
    effectiveActionKind: automaticPromotion ? "AUTOMATIC_FORMAL" : null,
    voiceTemplateId: rule?.voiceTemplateId || null,
    audioAssetId: rule?.audioAssetId || null,
    allowRealIntercom: Boolean(rule?.allowRealIntercom),
    requireVehicleAllowlist: rule?.requireVehicleAllowlist !== false,
    failureAction: rule?.failureAction || "MANUAL_REVIEW",
    reminderPolicy,
    completionAssessment: rule ? evaluateCompletion(event, rule) : {
      status: "UNKNOWN_MANUAL",
      source: "MANUAL_CONFIRMATION",
      reason: "没有命中的已发布规则，必须人工确认",
      manualRequired: true,
      observedFields: [],
    },
    channels: Array.isArray(rule?.channels) ? structuredClone(rule.channels).sort((a, b) => Number(a.order) - Number(b.order)) : [],
    channelStrategy: rule?.channelStrategy || ((rule?.channels || []).length <= 1 ? "SINGLE" : "SEQUENTIAL"),
    retryPolicy: structuredClone(rule?.retryPolicy || { maxRetries: 2, delaysMs: [5000, 10000], retryOn: ["FAILED"], maxDurationMs: 30000 }),
    fallback: rule?.fallback || "MANUAL",
    decidedAt
  };
}

function renderFixedText(template, event) {
  const missing = [];
  const text = String(template || "").replace(/\{(vehicleNo|alarmName|alarmTime|companyName|location)\}/g, (_match, field) => {
    const value = event?.[field];
    if (value === null || value === undefined || value === "") { missing.push(field); return ""; }
    return String(value);
  });
  return { text, missing };
}

export function createResponsePlan(event, decision, settings, responseAssets = {}) {
  const assets = runtimeAssetMap(responseAssets);
  const mode = "LIVE";
  const createdAt = new Date().toISOString();
  const automaticExecutionAuthorized = settings?.automaticRealActions === true;
  const attempts = (decision.channels || []).map((channel) => {
    const assetKey = channel.type === "TEXT" ? channel.templateId : channel.assetId;
    const asset = assets[assetKey];
    const blockers = [];
    if (decision.action !== "RESPONSE_PLAN") blockers.push("规则未生成自动响应计划");
    if (channel.type === "VOICE" && mode === "LIVE" && decision.allowRealIntercom !== true) blockers.push("规则未授权真实自动语音对讲");
    if (!asset || asset.channelType !== channel.type) blockers.push("已发布响应资产不存在或类型不匹配");
    if (!event.vehicleId && !event.vehicleNo) blockers.push("缺少车辆标识");
    if (!automaticExecutionAuthorized) blockers.push("真实自动动作策略未启用");
    let renderedText = null;
    if (channel.type === "TEXT" && asset) {
      const rendered = renderFixedText(asset.textTemplate, event);
      renderedText = rendered.text;
      if (rendered.missing.length) blockers.push(`固定文本变量缺失: ${rendered.missing.join(",")}`);
    } else if (channel.type === "VOICE") {
      const rendered = renderFixedText(channel.spokenTemplate, event);
      renderedText = rendered.text;
      if (!renderedText.trim()) blockers.push("固定语音话术为空");
      if (rendered.missing.length) blockers.push(`固定语音变量缺失: ${rendered.missing.join(",")}`);
    }
    return {
      actionId: `action:${stableHash(`${decision.decisionId}|${channel.type}|${channel.order}|${mode}`)}`,
      eventId: event.eventId,
      decisionId: decision.decisionId,
      type: channel.type === "TEXT" && channel.terminalTts === true ? "TEXT_TTS" : channel.type === "TEXT" ? "TEXT_MESSAGE" : "VOICE_INTERCOM",
      channelType: channel.type,
      terminalTts: channel.type === "TEXT" && channel.terminalTts === true,
      order: channel.order,
      recipientType: channel.recipientType,
      assetKey,
      assetVersion: asset?.version || null,
      assetHash: asset?.contentHash || null,
      renderedText,
      audioAssetId: channel.type === "VOICE" ? assetKey : null,
      audioAssetPath: channel.type === "VOICE" ? asset?.audioPath || null : null,
      mode,
      status: blockers.length ? "BLOCKED" : "PLANNED",
      blockers,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      retryPolicy: structuredClone(decision.retryPolicy),
    };
  });
  const blockers = attempts.flatMap((attempt) => attempt.blockers.map((blocker) => `${attempt.channelType}: ${blocker}`));
  return {
    actionId: `plan:${stableHash(`${decision.decisionId}|${mode}`)}`,
    eventId: event.eventId,
    decisionId: decision.decisionId,
    type: "RESPONSE_PLAN",
    mode,
    status: attempts.length && !blockers.length ? "PLANNED" : "BLOCKED",
    blockers,
    attempts,
    channelStrategy: decision.channelStrategy || (attempts.length <= 1 ? "SINGLE" : "SEQUENTIAL"),
    fallback: decision.fallback || "MANUAL",
    automaticPromotion: decision.automaticPromotion === true,
    effectiveActionKind: decision.effectiveActionKind || null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export function createActionAttempt(event, decision, settings, audioAsset) {
  const liveRequested = true;
  const vehicleKey = event.vehicleId || event.vehicleNo;
  const blockers = [];
  if (decision.action !== "AUTO_VOICE") blockers.push("规则未选择自动语音");
  if (decision.action === "AUTO_VOICE" && !vehicleKey) blockers.push("缺少车辆标识，无法执行对讲");
  if (!audioAsset?.confirmed) blockers.push("固定音频未确认或不存在");
  if (liveRequested && !decision.allowRealIntercom) blockers.push("规则不允许真实对讲");
  if (liveRequested && !settings.intercom?.verified) blockers.push("平台对讲调用链尚未验证");
  const mode = "LIVE";
  const createdAt = new Date().toISOString();
  return {
    actionId: `action:${stableHash(`${decision.decisionId}|${mode}`)}`,
    eventId: event.eventId,
    decisionId: decision.decisionId,
    type: "VOICE_INTERCOM",
    mode,
    status: blockers.length ? "BLOCKED" : "PLANNED",
    blockers,
    vehicleId: event.vehicleId,
    vehicleNo: event.vehicleNo,
    audioAssetId: decision.audioAssetId,
    audioHash: audioAsset?.sha256 || null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null
  };
}

export function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function toLedgerRow(event, decision, action) {
  const attempts = Array.isArray(action?.attempts) ? action.attempts : [];
  return {
    alarmId: event.alarmId || "",
    eventId: event.eventId,
    vehicleNo: event.vehicleNo || "",
    driverName: event.driverName || "",
    companyName: event.companyName || "",
    alarmTypeId: event.alarmTypeId || "",
    alarmName: event.alarmName || "",
    alarmTime: event.alarmTime || "",
    alarmSource: event.sourceLabel || alarmSourceMeta(event.rawEndpoint).label,
    location: event.location || "",
    locationSpeed: event.locationSpeed ?? "",
    platformStatus: event.platformStatus || "",
    alarmStatus: event.alarmStatus || "",
    alarmCompleteStatus: event.alarmCompleteStatus || "",
    dealFlag: event.dealFlag || "",
    dispositionFlag: event.dispositionFlag || "",
    ignoreStatus: event.ignoreStatus || "",
    verificationStatus: event.verificationStatus || "",
    evidenceAuditStatus: event.evidenceAuditStatus || "",
    appealResult: event.appealResult || "",
    positiveReportingFlag: event.positiveReportingFlag || "",
    ruleSetVersion: decision?.ruleSetVersion || "",
    ruleId: decision?.ruleId || "",
    treatment: decision?.action || "MANUAL_REVIEW",
    voiceTemplateId: decision?.voiceTemplateId || "",
    audioAssetId: decision?.audioAssetId || "",
    responseChannels: (decision?.channels || []).map((channel) => channel.type).join("→"),
    textTemplateIds: (decision?.channels || []).filter((channel) => channel.type === "TEXT").map((channel) => channel.templateId).join("；"),
    voiceAssetIds: (decision?.channels || []).filter((channel) => channel.type === "VOICE").map((channel) => channel.assetId).join("；"),
    channelResults: attempts.map((attempt) => `${attempt.channelType}:${attempt.status}`).join("；"),
    reminderCategory: decision?.reminderPolicy?.category || "",
    driverReminderMode: decision?.reminderPolicy?.driverReminder || "",
    secondaryChannelMode: decision?.reminderPolicy?.secondaryChannelMode || "",
    completionStatus: decision?.completionAssessment?.status || event?.completionAssessment?.status || "UNKNOWN_MANUAL",
    completionSource: decision?.completionAssessment?.source || event?.completionAssessment?.source || "MANUAL_CONFIRMATION",
    completionReason: decision?.completionAssessment?.reason || event?.completionAssessment?.reason || "",
    completionManualRequired: (decision?.completionAssessment?.manualRequired || event?.completionAssessment?.manualRequired) ? "是" : "否",
    actionMode: action?.mode || "",
    actionStatus: action?.status || "",
    actionStartedAt: action?.startedAt || "",
    actionFinishedAt: action?.finishedAt || "",
    failureReason: action?.error || action?.blockers?.join("；") || "",
    manualRequired: decision?.action === "MANUAL_REVIEW" || ["BLOCKED", "FAILED", "UNKNOWN", "MANUAL_REQUIRED"].includes(action?.status) ? "是" : "否",
    notes: (event.notes || []).map((item) => item.text).join("；"),
    finalState: event.state,
    updatedAt: event.updatedAt
  };
}

export function rowsToCsv(rows) {
  if (!rows.length) return "\ufeff";
  const headers = Object.keys(rows[0]);
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return `\ufeff${headers.map(quote).join(",")}\r\n${rows.map((row) => headers.map((key) => quote(row[key])).join(",")).join("\r\n")}`;
}

export function maskLedgerRow(row) {
  const mask = (value, head = 1, tail = 0) => {
    const text = String(value || "");
    if (!text) return "";
    if (text.length <= head + tail) return `${text.slice(0, head)}***`;
    return `${text.slice(0, head)}****${tail ? text.slice(-tail) : ""}`;
  };
  return {
    ...row,
    alarmId: mask(row.alarmId, 6, 4),
    vehicleNo: mask(row.vehicleNo, 2, 2),
    driverName: mask(row.driverName, 1),
    companyName: mask(row.companyName, 4),
    location: mask(row.location, 6),
    notes: row.notes ? "[值班备注已隐藏]" : ""
  };
}
