const SESSION_STATUSES = new Set(["AUTHENTICATED", "LOGIN_REQUIRED", "UNKNOWN"]);
const RECOVERY_SOURCES = ["realtime-alarms", "technical-alarms"];

function safeText(value, fallback = "") {
  return String(value ?? fallback).slice(0, 300);
}

function safeRoute(value) {
  return String(value || "")
    .split("?")[0]
    .replace(/[a-f0-9]{16,}/gi, ":id")
    .replace(/\d{8,}/g, ":id")
    .slice(0, 200) || null;
}

export function isHnPlatformUrl(value) {
  try {
    const hostname = new URL(String(value)).hostname.toLowerCase();
    return hostname === "hnznjg.cn" || hostname.endsWith(".hnznjg.cn");
  } catch {
    return false;
  }
}

export function defaultPlatformSession() {
  return {
    status: "UNKNOWN",
    route: null,
    reason: "等待省平台页面状态",
    detectedAt: null,
    statusChangedAt: null,
    lastAuthenticatedAt: null,
    lastLoginRequiredAt: null,
    recoveryRequired: false,
    recoveryPendingSources: [],
    platformDisplayName: "",
    platformIdentityStatus: "UNKNOWN",
    platformVisibleScopeHash: "",
    platformPermissionSummary: {},
    platformIdentityObservedAt: null
  };
}

export function normalizePlatformSession(previous, report, now = new Date().toISOString()) {
  const prior = { ...defaultPlatformSession(), ...(previous || {}) };
  const status = SESSION_STATUSES.has(report?.status) ? report.status : "UNKNOWN";
  const changed = prior.status !== status;
  const next = {
    ...prior,
    status,
    route: safeRoute(report?.route || prior.route || ""),
    reason: safeText(report?.reason || prior.reason || ""),
    detectedAt: now,
    platformDisplayName: safeText(report?.platformDisplayName || prior.platformDisplayName || "", "").slice(0, 100),
    platformIdentityStatus: ["UNKNOWN", "UNVERIFIED", "VERIFIED"].includes(String(report?.platformIdentityStatus || prior.platformIdentityStatus || "UNKNOWN").toUpperCase())
      ? String(report?.platformIdentityStatus || prior.platformIdentityStatus || "UNKNOWN").toUpperCase()
      : "UNKNOWN",
    platformVisibleScopeHash: /^[0-9a-f]{64}$/i.test(String(report?.platformVisibleScopeHash || prior.platformVisibleScopeHash || ""))
      ? String(report?.platformVisibleScopeHash || prior.platformVisibleScopeHash).toLowerCase()
      : "",
    platformPermissionSummary: report?.platformPermissionSummary && typeof report.platformPermissionSummary === "object"
      ? Object.fromEntries(Object.entries(report.platformPermissionSummary).filter(([key, value]) => /^[A-Za-z0-9_.:-]{1,80}$/.test(key) && ["boolean", "number", "string"].includes(typeof value)).slice(0, 50))
      : prior.platformPermissionSummary || {},
    platformIdentityObservedAt: report?.platformIdentityObservedAt || prior.platformIdentityObservedAt || null,
    statusChangedAt: changed ? now : prior.statusChangedAt
  };

  if (status === "LOGIN_REQUIRED") {
    next.lastLoginRequiredAt = now;
    next.recoveryRequired = true;
    next.recoveryPendingSources = [...RECOVERY_SOURCES];
  } else if (status === "AUTHENTICATED") {
    next.lastAuthenticatedAt = now;
  }
  return next;
}

export function platformSessionFromCapture(previous, record, now = new Date().toISOString()) {
  let next = { ...defaultPlatformSession(), ...(previous || {}) };
  if (!isHnPlatformUrl(record?.url)) return next;
  if ([401, 403].includes(Number(record?.status))) {
    return normalizePlatformSession(next, {
      status: "LOGIN_REQUIRED",
      route: record?.route,
      reason: `接口返回 HTTP ${record.status}`
    }, now);
  }
  if (record?.ok && !/^#\/login(?:$|[/?])/i.test(String(record?.route || ""))) {
    next = normalizePlatformSession(next, {
      status: "AUTHENTICATED",
      route: record?.route,
      reason: "已收到省平台授权接口响应"
    }, now);
    if (RECOVERY_SOURCES.includes(record?.matchedRule)) {
      next.recoveryPendingSources = next.recoveryPendingSources.filter((source) => source !== record.matchedRule);
      next.recoveryRequired = next.recoveryPendingSources.length > 0;
    }
  }
  return next;
}

export function platformSessionBlocker(session, mode) {
  if (mode !== "LIVE") return null;
  if (session?.status !== "AUTHENTICATED") return "省平台未登录或登录状态无法确认，真实动作已暂停";
  if (session?.recoveryRequired) return "省平台重新登录后尚未完成实时报警和技术检测补采，真实动作保持暂停";
  return null;
}

export const PLATFORM_SESSION_RECOVERY_SOURCES = [...RECOVERY_SOURCES];
