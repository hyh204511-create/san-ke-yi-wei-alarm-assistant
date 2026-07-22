import {
  alarmEventTime,
  alarmSourcePriority,
  compareAlarmOrder,
  createActionAttempt,
  createResponsePlan,
  createSpeedingPrewarningTestDecision,
  enterpriseAccessForEvent,
  evaluateCompletion,
  evaluateRules,
  extractAlarmCandidates,
  mergeAlarmEvents,
  normalizeAlarmRow,
  toLedgerRow,
  validateRuntimeRuleSet
} from "./alarm-domain.js";
import { executeSandboxIntercom } from "./sandbox-intercom.js";
import { executeSandboxText } from "./sandbox-text.js";
import { executeWithRetry } from "./response-retry.js";
import { executeVoiceThenTextFallback } from "./response-plan-execution.js";
import { createPlatformAuthCache } from "./platform-auth-cache.js";
import { pollReportTasks } from "./report-task-runner.js";
import {
  defaultPlatformSession,
  isHnPlatformUrl,
  normalizePlatformSession,
  platformSessionBlocker,
  platformSessionFromCapture
} from "./platform-session.js";

const COLLECTOR_BASE = "http://127.0.0.1:17321";
const DEFAULT_ASSISTANT_BASE = "http://127.0.0.1:18080/assistant";
const STATE_KEY = "collectorState";
const SETTINGS_KEY = "assistantSettings";
const RULES_KEY = "activeRuleSet";
const RULES_META_KEY = "activeRuleSetMeta";
const RESPONSE_ASSETS_KEY = "activeResponseAssets";
const AUDIO_KEY = "audioAssets";
const IDENTITY_SNAPSHOT_KEY = "assistantIdentitySnapshot";
const RULE_SYNC_INTERVAL_MS = 30 * 1000;
const MAX_OUTBOX = 200;
const MAX_EVENTS = 200;
const SENSITIVE_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ALLOWLIST_ITEMS = 1000;
const KEEPALIVE_ALARM = "authorized-session-keepalive";
const HEARTBEAT_ALARM = "assistant-device-heartbeat";
const REPORT_TASK_ALARM = "five-source-report-task-poll";
const REPORT_TASK_MONITOR_KEY = "reportTaskMonitor";
const KEEPALIVE_POLICY_RETRY_MINUTES = 5;
const KEEPALIVE_TARGETS = Object.freeze([
  Object.freeze({ route: "#/alarm-center/alarm-preprocessing", actionKey: "ALARM_PREPROCESSING_QUERY", mode: "CLICK_QUERY" }),
  Object.freeze({ route: "#/vehicle-monitor/real-time", actionKey: "REALTIME_MONITOR_OBSERVE", mode: "READ_ONLY_OBSERVE" }),
  Object.freeze({ route: "#/alarm-center/pr-alarm-recorde", actionKey: "PREWARNING_LIST_OBSERVE", mode: "READ_ONLY_OBSERVE" }),
]);

const DEFAULT_SETTINGS = {
  assistantBase: DEFAULT_ASSISTANT_BASE,
  mode: "DRY_RUN",
  vehicleAllowlist: [],
  intercom: {
    verified: false,
    startPath: "/api/schedule-service/sendVideo/sendRealAudioTransmissionMessage",
    keepalivePath: "/api/gpsp-service/sendVideo/sendRealAudioKeepMessage",
    stopPath: "/api/schedule-service/sendVideo/sendRealAudioControlMessage"
  },
  prewarningTest: {
    targetEventId: null,
    approvedAt: null,
    expiresAt: null,
    consumedAt: null,
  },
  popupSelectors: ["#sandbox-alarm-popup:not(.hidden)", ".alarm-detail-dialog"]
};

const BUNDLED_SPEEDING_ASSETS = Object.freeze({
  "voice-speeding-v1": Object.freeze({
    assetKey: "voice-speeding-v1",
    version: "v1",
    channelType: "VOICE",
    contentHash: "94974f7f4ed6691a248969d85653801144ddf4b097476db9bf2c6cb19cd9498e",
    audioPath: "assets/alarm-audio/speeding-female-8k-mono.pcm",
    sampleRate: 8000,
    channels: 1,
    bitsPerSample: 16,
    durationMs: 8662,
  }),
  "text-speeding-v1": Object.freeze({
    assetKey: "text-speeding-v1",
    version: "v1",
    channelType: "TEXT",
    contentHash: "9d4d795697e27dd4d8da287fa649f8417c4a14e4b3f1eec565c9cf2c58ca24d7",
    textTemplate: "驾驶员，平台已报警，车辆超速驾驶，请降速安全行驶。",
  }),
});

const platformAuthCache = createPlatformAuthCache();
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => { platformAuthCache.observe(details); },
  { urls: ["https://*.hnznjg.cn:7443/api/*"], types: ["xmlhttprequest"] },
  ["requestHeaders", "extraHeaders"],
);

const DEFAULT_STATE = {
  outboxIds: [],
  eventIds: [],
  eventOrder: {},
  primaryTabId: null,
  deviceId: null,
  activeVehicleActions: {},
  platformSession: defaultPlatformSession(),
  keepalive: {
    policy: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextScheduledAt: null,
    lastResultCode: null,
    lastLatencyMs: null,
  },
  serverOnline: false,
  stats: {
    captured: 0,
    alarms: 0,
    saved: 0,
    events: 0,
    manual: 0,
    autoVoice: 0,
    recordOnly: 0,
    failedActions: 0,
    lastCaptureReceivedAt: null,
    lastUiReadyAt: null,
    lastDecisionLatencyMs: null,
    maxDecisionLatencyMs: null,
    backgroundPending: 0,
    backgroundFailed: 0,
    lastCaptureAt: null,
    lastRule: null,
    lastError: null
  }
};

let storageQueue = Promise.resolve();
let processingQueue = Promise.resolve();
let ruleSyncPromise = null;
let ruleSyncPromiseKey = null;
let assistantIdentityCache = null;
let assistantIdentityCachedAt = 0;
let assistantActionTokenCache = null;
let assistantActionTokenKey = null;
let assistantActionTokenCachedAt = 0;
let dutyNotificationCache = { fetchedAt: 0, rows: [] };

function withStorage(task) {
  const next = storageQueue.then(task, task);
  storageQueue = next.catch(() => {});
  return next;
}

function withProcessing(task) {
  const next = processingQueue.then(task, task);
  processingQueue = next.catch(() => {});
  return next;
}

function normalizeState(value = {}) {
  return {
    ...DEFAULT_STATE,
    ...value,
    stats: { ...DEFAULT_STATE.stats, ...(value.stats || {}) },
    outboxIds: value.outboxIds || value.pendingIds || [],
    eventIds: value.eventIds || [],
    eventOrder: value.eventOrder || {},
    activeVehicleActions: value.activeVehicleActions || {},
    platformSession: { ...defaultPlatformSession(), ...(value.platformSession || {}) },
    keepalive: { ...DEFAULT_STATE.keepalive, ...(value.keepalive || {}) }
  };
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return normalizeState(stored[STATE_KEY] || {});
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] || {}),
    intercom: { ...DEFAULT_SETTINGS.intercom, ...(stored[SETTINGS_KEY]?.intercom || {}) },
    prewarningTest: { ...DEFAULT_SETTINGS.prewarningTest, ...(stored[SETTINGS_KEY]?.prewarningTest || {}) },
  };
}

function validateAssistantBase(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(normalized); } catch { throw new Error("助手服务器地址无效"); }
  const local = ["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol === "http:";
  if (!local && url.protocol !== "https:") throw new Error("远程助手服务器必须使用 HTTPS");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/assistant") throw new Error("助手服务器地址必须以 /assistant 结尾且不能包含凭据、参数或片段");
  return normalized;
}

async function assistantBase() {
  return validateAssistantBase((await getSettings()).assistantBase || DEFAULT_ASSISTANT_BASE);
}

async function assistantUrl(path) {
  return `${await assistantBase()}${path}`;
}

async function getDeviceId() {
  return withStorage(async () => {
    const state = await getState();
    if (!state.deviceId) {
      state.deviceId = crypto.randomUUID();
      await setState(state);
    }
    return state.deviceId;
  });
}

async function getAudioAssets() {
  const stored = await chrome.storage.local.get(AUDIO_KEY);
  return stored[AUDIO_KEY] || {};
}

async function getResponseAssets() {
  const stored = await chrome.storage.local.get(RESPONSE_ASSETS_KEY);
  return stored[RESPONSE_ASSETS_KEY] || {};
}

async function getAssistantIdentity({ force = false } = {}) {
  if (!force && assistantIdentityCache && Date.now() - assistantIdentityCachedAt < 5000) return assistantIdentityCache;
  try {
    const response = await fetch(await assistantUrl("/api/me"), {
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      assistantIdentityCache = { authenticated: false, status: response.status, code: payload?.code || "IDENTITY_UNAVAILABLE", message: payload?.message || "助手身份不可用" };
      assistantIdentityCachedAt = Date.now();
      await chrome.storage.local.set({ [IDENTITY_SNAPSHOT_KEY]: assistantIdentityCache });
      return assistantIdentityCache;
    }
    assistantIdentityCache = { authenticated: true, ...payload.data };
    assistantIdentityCachedAt = Date.now();
    await chrome.storage.local.set({
      [IDENTITY_SNAPSHOT_KEY]: {
        authenticated: true,
        userId: assistantIdentityCache.userId,
        displayName: assistantIdentityCache.displayName,
        roles: assistantIdentityCache.roles || [],
        permissions: assistantIdentityCache.permissions || [],
        enterpriseScopes: assistantIdentityCache.enterpriseScopes || [],
        activeShift: assistantIdentityCache.activeShift ? {
          shiftId: assistantIdentityCache.activeShift.shiftId,
          workstationId: assistantIdentityCache.activeShift.workstationId,
        } : null,
        cachedAt: new Date().toISOString(),
      }
    });
    return assistantIdentityCache;
  } catch (error) {
    assistantIdentityCache = { authenticated: false, status: 0, code: "IDENTITY_SERVICE_OFFLINE", message: String(error?.message || error) };
    assistantIdentityCachedAt = Date.now();
    return assistantIdentityCache;
  }
}

async function getCachedAssistantIdentity(stored = null) {
  if (assistantIdentityCache) return assistantIdentityCache;
  const values = stored || await chrome.storage.local.get(IDENTITY_SNAPSHOT_KEY);
  return values[IDENTITY_SNAPSHOT_KEY] || { authenticated: false, code: "IDENTITY_REFRESH_PENDING", message: "实名身份正在后台刷新" };
}

async function requireAssistantPermission(permission, { requireShift = false } = {}) {
  const identity = await getAssistantIdentity({ force: true });
  if (!identity.authenticated) throw new Error("请先登录本机实名助手账号");
  if (!(identity.permissions || []).includes(permission)) throw new Error(`当前实名角色缺少权限：${permission}`);
  if (requireShift && !identity.activeShift) throw new Error("请先在助手身份页认领当前值班班次");
  return identity;
}

async function getAssistantActionToken(identity, { force = false } = {}) {
  const identityKey = identity?.authenticated ? String(identity.userId) : null;
  if (!identityKey) throw new Error("请先登录本机实名助手账号");
  if (!force && assistantActionTokenCache && assistantActionTokenKey === identityKey && Date.now() - assistantActionTokenCachedAt < 4 * 60 * 1000) {
    return assistantActionTokenCache;
  }
  const response = await fetch(await assistantUrl("/api/action-token"), { credentials: "include", cache: "no-store", headers: { accept: "application/json" } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload?.data?.actionToken) throw new Error(payload?.message || `助手操作令牌 HTTP ${response.status}`);
  assistantActionTokenCache = payload.data.actionToken;
  assistantActionTokenKey = identityKey;
  assistantActionTokenCachedAt = Date.now();
  return assistantActionTokenCache;
}

async function assistantMutation(path, body, identity, { retryToken = true } = {}) {
  const actionToken = await getAssistantActionToken(identity, { force: !retryToken });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetch(await assistantUrl(path), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", "x-assistant-action-token": actionToken },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    if (retryToken && ["ACTION_TOKEN_REQUIRED", "ACTION_TOKEN_MISMATCH"].includes(payload?.code)) {
      return assistantMutation(path, body, identity, { retryToken: false });
    }
    const error = new Error(payload?.message || `助手处置服务 HTTP ${response.status}`);
    error.code = payload?.code || "ASSISTANT_MUTATION_FAILED";
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function assistantGet(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(await assistantUrl(path), {
      credentials: "include", cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.message || `助手报表服务 HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function monitorReportTasks() {
  try {
    const identity = await getAssistantIdentity({ force: true });
    const result = await pollReportTasks({ assistantGet, identity });
    await chrome.storage.local.set({ [REPORT_TASK_MONITOR_KEY]: { ...result, checkedAt: new Date().toISOString() } });
  } catch (error) {
    await chrome.storage.local.set({
      [REPORT_TASK_MONITOR_KEY]: {
        code: "REPORT_TASK_POLL_FAILED", tasks: [], blocked: [],
        message: String(error?.message || error).slice(0, 300), checkedAt: new Date().toISOString(),
      },
    });
  }
}

async function getDutyNotifications(identity, { force = false } = {}) {
  if (!identity?.authenticated || !(identity.permissions || []).includes("alarm.view")) return [];
  if (!force && Date.now() - dutyNotificationCache.fetchedAt < 5000) return dutyNotificationCache.rows;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(await assistantUrl("/reports/api/notifications?limit=20"), {
      credentials: "include", cache: "no-store", headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.data)) throw new Error("通知服务不可用");
    dutyNotificationCache = { fetchedAt: Date.now(), rows: payload.data.slice(0, 20) };
  } catch {
    dutyNotificationCache = { fetchedAt: Date.now(), rows: [] };
  } finally {
    clearTimeout(timeout);
  }
  return dutyNotificationCache.rows;
}

async function acquireServerActionLease(event, action, identity) {
  if (!identity?.authenticated || !identity.activeShift || action?.mode !== "LIVE") return null;
  const actionType = action.type === "RESPONSE_PLAN"
    ? "RESPONSE_PLAN"
    : action.channelType === "TEXT" || action.type === "TEXT_TTS"
      ? "TEXT_TTS"
      : "VOICE_INTERCOM";
  const response = await assistantMutation("/reports/api/action-leases/acquire", {
    eventId: event.eventId,
    deviceId: await getDeviceId(),
    actionType,
    mode: "LIVE",
    durationSeconds: actionType === "RESPONSE_PLAN" ? 180 : 90,
  }, identity);
  return response?.data || null;
}

async function reportServerActionResult(lease, action, identity) {
  if (!lease?.leaseId || !lease?.leaseToken || !identity?.authenticated) return;
  const resultCode = ["SUCCEEDED", "FAILED", "UNKNOWN", "BLOCKED", "MANUAL_REQUIRED"].includes(action?.status)
    ? action.status : "UNKNOWN";
  const safeResult = {};
  const attempts = Array.isArray(action?.attempts) ? action.attempts : [];
  const voiceAttempt = attempts.find((item) => item.channelType === "VOICE");
  const textAttempt = attempts.find((item) => item.channelType === "TEXT");
  const source = {
    ...(action?.result && typeof action.result === "object" ? action.result : {}),
    ...(attempts.length ? {
      processingStatus: action.processingStatus || action.status,
      voiceStatus: voiceAttempt?.status || "NOT_ATTEMPTED",
      textStatus: textAttempt?.status || "NOT_ATTEMPTED",
      fallbackUsed: action.fallbackUsed === true,
      bytesSent: Number(voiceAttempt?.result?.bytesSent || 0),
      durationMs: attempts.reduce((total, item) => total + Number(item?.result?.durationMs || 0), 0),
    } : {}),
  };
  for (const key of [
    "receiptRef", "errorCode", "messageCode", "latencyMs", "attemptNumber", "simulated",
    "terminalTts", "playbackStarted", "platformHttpStatus", "processingStatus", "voiceStatus",
    "textStatus", "fallbackUsed", "bytesSent", "durationMs",
  ]) {
    if (source[key] !== undefined) safeResult[key] = source[key];
  }
  try {
    await assistantMutation(`/reports/api/action-leases/${encodeURIComponent(lease.leaseId)}/result`, {
      leaseToken: lease.leaseToken,
      deviceId: await getDeviceId(),
      actionId: action?.actionId || "",
      resultCode,
      result: safeResult,
    }, identity);
  } catch (error) {
    await audit("ACTION_RESULT_SYNC_FAILED", { code: error?.code || "UNKNOWN", status: error?.status || 0 });
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function loadVerifiedPcmBase64(attempt) {
  const asset = BUNDLED_SPEEDING_ASSETS[attempt.assetKey];
  if (!asset || asset.channelType !== "VOICE" || asset.audioPath !== attempt.audioAssetPath) {
    throw new Error("固定语音资产不在批准清单");
  }
  const response = await fetch(chrome.runtime.getURL(asset.audioPath), { cache: "no-store" });
  if (!response.ok) throw new Error("固定语音资产读取失败");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  if (hash !== asset.contentHash || bytes.length !== 138596) throw new Error("固定语音资产完整性校验失败");
  return bytesToBase64(bytes);
}

async function livePlatformTab(senderTabId) {
  if (senderTabId != null) {
    try {
      const tab = await chrome.tabs.get(senderTabId);
      if (isHnPlatformUrl(tab.url) && new URL(tab.url).hash.split("?")[0] === "#/vehicle-monitor/real-time") return tab;
    } catch {}
  }
  return chooseHnPlatformTab([
    { route: "#/vehicle-monitor/real-time", actionKey: "SPEEDING_SINGLE_TEST", mode: "LIVE_ACTION" },
  ]);
}

async function executeLivePlatformAttempt(original, event, senderTabId) {
  const tab = await livePlatformTab(senderTabId);
  if (!tab?.id) return { status: "BLOCKED", error: "未找到已登录的省平台实时监控页" };
  let authorization = platformAuthCache.get(tab.id, tab.url);
  const authDeadline = Date.now() + 6000;
  while (!authorization && Date.now() < authDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    authorization = platformAuthCache.get(tab.id, tab.url);
  }
  if (!authorization) {
    return { status: "BLOCKED", error: "尚未观察到当前实时监控标签的短期平台认证上下文" };
  }
  let pcmBase64 = null;
  if (original.channelType === "VOICE") {
    try {
      pcmBase64 = await loadVerifiedPcmBase64(original);
    } catch (error) {
      return { status: "BLOCKED", error: String(error?.message || error) };
    }
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "PLATFORM_ACTION_EXECUTE",
      request: {
        operation: original.channelType,
        actionId: original.actionId,
        renderedText: original.renderedText,
        pcmBase64,
        authorization,
        event: {
          alarmId: event.alarmId,
          alarmTime: event.alarmTime,
          alarmName: event.alarmName,
          sourceKind: event.sourceKind,
          vehicleId: event.vehicleId,
          vehicleNo: event.vehicleNo,
          certColor: event.certColor || "",
        },
      },
    });
    const status = ["SUCCEEDED", "FAILED", "UNKNOWN", "BLOCKED"].includes(response?.status)
      ? response.status
      : "UNKNOWN";
    const safe = {};
    for (const key of ["receiptRef", "errorCode", "platformHttpStatus", "terminalTts", "playbackStarted", "bytesSent", "durationMs"]) {
      if (response?.[key] !== undefined) safe[key] = response[key];
    }
    return {
      status,
      result: safe,
      error: status === "SUCCEEDED" ? null : String(response?.errorCode || "平台动作结果未知"),
      blockers: status === "BLOCKED" ? [String(response?.errorCode || "平台动作被阻断")] : [],
    };
  } catch {
    return { status: "UNKNOWN", error: "插件与省平台页面通信中断，动作结果未知" };
  }
}

async function bundledRuleSet() {
  const response = await fetch(chrome.runtime.getURL("default-rules.json"));
  return response.json();
}

function identityRuleCacheKey(identity) {
  if (!identity?.authenticated) return null;
  const scopes = (identity.enterpriseScopes || []).map((scope) => scope.enterpriseId).filter(Boolean).sort();
  return `${identity.userId}|${scopes.join(",")}`;
}

async function syncPublishedRuleSet({ force = false, identity = null } = {}) {
  const runtimeIdentity = identity || await getAssistantIdentity();
  const consumerKey = identityRuleCacheKey(runtimeIdentity);
  if (ruleSyncPromise && ruleSyncPromiseKey === consumerKey) return ruleSyncPromise;
  if (ruleSyncPromise) {
    await ruleSyncPromise.catch(() => {});
    return syncPublishedRuleSet({ force, identity: runtimeIdentity });
  }
  ruleSyncPromiseKey = consumerKey;
  ruleSyncPromise = (async () => {
    const stored = await chrome.storage.local.get([RULES_KEY, RULES_META_KEY, RESPONSE_ASSETS_KEY]);
    const cachedRuleSet = stored[RULES_KEY] || null;
    const cachedResponseAssets = stored[RESPONSE_ASSETS_KEY] || {};
    const meta = stored[RULES_META_KEY] || {};
    const trustedCachedRuleSet = consumerKey && meta.source === "RULE_CENTER" && meta.consumerKey === consumerKey && cachedRuleSet ? cachedRuleSet : null;
    const lastAttemptAt = Date.parse(meta.lastAttemptAt || "") || 0;
    if (!force && Date.now() - lastAttemptAt < RULE_SYNC_INTERVAL_MS) return trustedCachedRuleSet || bundledRuleSet();

    const attemptAt = new Date().toISOString();
    try {
      const response = await fetch(await assistantUrl("/rules/api/runtime"), {
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" }
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload?.data?.runtimeRuleSet) {
        throw new Error(payload?.message || `规则中心 HTTP ${response.status}`);
      }
      const ruleSet = payload.data.runtimeRuleSet;
      const responseAssets = Object.fromEntries((payload.data.responseAssets || []).map((asset) => [asset.assetKey, asset]));
      const validation = await validateRuntimeRuleSet(ruleSet, ruleSet.schemaVersion === 2 ? responseAssets : await getAudioAssets());
      if (!validation.ok) throw new Error(`服务端运行规则无效：${validation.errors.join("；")}`);
      await chrome.storage.local.set({
        [RULES_KEY]: ruleSet,
        [RESPONSE_ASSETS_KEY]: responseAssets,
        [RULES_META_KEY]: {
          source: "RULE_CENTER",
          version: ruleSet.version,
          contentHash: ruleSet.contentHash || null,
          consumerKey,
          lastAttemptAt: attemptAt,
          lastSuccessfulAt: attemptAt,
          lastError: null
        }
      });
      return ruleSet;
    } catch (error) {
      await chrome.storage.local.set({
        [RULES_META_KEY]: {
          ...meta,
          source: trustedCachedRuleSet ? "RULE_CENTER" : "BUNDLED_SAFE_DEFAULT",
          consumerKey,
          lastAttemptAt: attemptAt,
          lastError: String(error?.message || error)
        }
      });
      if (!trustedCachedRuleSet) await chrome.storage.local.set({ [RESPONSE_ASSETS_KEY]: {} });
      else if (!Object.keys(cachedResponseAssets).length && trustedCachedRuleSet.schemaVersion === 2) throw new Error("已缓存规则缺少响应资产，拒绝运行");
      return trustedCachedRuleSet || bundledRuleSet();
    }
  })();
  try {
    return await ruleSyncPromise;
  } finally {
    ruleSyncPromise = null;
    ruleSyncPromiseKey = null;
  }
}

async function getRuleSet(identity = null) {
  return syncPublishedRuleSet({ identity });
}

async function getRuleSetMeta() {
  const stored = await chrome.storage.local.get(RULES_META_KEY);
  return stored[RULES_META_KEY] || { source: "BUNDLED_SAFE_DEFAULT", lastError: "尚未连接规则中心" };
}

async function getCachedRuntimeContext(extraKeys = []) {
  const keys = [
    STATE_KEY, SETTINGS_KEY, RULES_KEY, RULES_META_KEY, RESPONSE_ASSETS_KEY, AUDIO_KEY, IDENTITY_SNAPSHOT_KEY,
    ...extraKeys,
  ];
  const [stored, bundled] = await Promise.all([
    chrome.storage.local.get(keys),
    bundledRuleSet(),
  ]);
  const identity = await getCachedAssistantIdentity(stored);
  const consumerKey = identityRuleCacheKey(identity);
  const meta = stored[RULES_META_KEY] || {};
  const trustedRuleSet = consumerKey && meta.source === "RULE_CENTER" && meta.consumerKey === consumerKey
    ? stored[RULES_KEY] || null
    : null;
  const settingsValue = stored[SETTINGS_KEY] || {};
  return {
    stored,
    state: normalizeState(stored[STATE_KEY] || {}),
    identity,
    ruleSet: trustedRuleSet || bundled,
    responseAssets: trustedRuleSet?.schemaVersion === 2 ? stored[RESPONSE_ASSETS_KEY] || {} : {},
    audioAssets: stored[AUDIO_KEY] || {},
    settings: {
      ...DEFAULT_SETTINGS,
      ...settingsValue,
      intercom: { ...DEFAULT_SETTINGS.intercom, ...(settingsValue.intercom || {}) },
      prewarningTest: { ...DEFAULT_SETTINGS.prewarningTest, ...(settingsValue.prewarningTest || {}) },
    },
    ruleSetMeta: trustedRuleSet ? meta : { ...meta, source: "BUNDLED_SAFE_DEFAULT" },
  };
}

function refreshRuntimeContextInBackground() {
  void (async () => {
    const identity = await getAssistantIdentity();
    await syncPublishedRuleSet({ identity });
  })().catch((error) => audit("RUNTIME_CONTEXT_REFRESH_FAILED", { error: String(error?.message || error).slice(0, 300) }));
}

function envelopeId(kind, record) {
  const base = record.captureId || record.eventId || record.decisionId || record.actionId || record.auditId;
  return `${kind}:${base}:${record.updatedAt || record.decidedAt || record.finishedAt || record.capturedAt || ""}`;
}

async function enqueue(kind, record) {
  return withStorage(async () => {
    const state = await getState();
    const id = envelopeId(kind, record);
    if (!state.outboxIds.includes(id)) state.outboxIds.push(id);
    while (state.outboxIds.length > MAX_OUTBOX) {
      const removed = state.outboxIds.shift();
      await chrome.storage.local.remove(`outbox:${removed}`);
      state.stats.lastError = "离线队列达到上限，最早记录已被移除";
    }
    await chrome.storage.local.set({ [`outbox:${id}`]: { id, kind, record } });
    await setState(state);
    return id;
  });
}

async function postEnvelope(envelope) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const path = envelope.kind === "capture" ? "/captures" : "/records";
    const body = envelope.kind === "capture" ? envelope.record : { kind: envelope.kind, record: envelope.record };
    const response = await fetch(`${COLLECTOR_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`本机服务 HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function markEnvelopeSaved(id) {
  return withStorage(async () => {
    const state = await getState();
    state.outboxIds = state.outboxIds.filter((item) => item !== id);
    state.serverOnline = true;
    state.stats.saved += 1;
    state.stats.lastError = null;
    await chrome.storage.local.remove(`outbox:${id}`);
    await setState(state);
  });
}

async function markOffline(error) {
  return withStorage(async () => {
    const state = await getState();
    state.serverOnline = false;
    state.stats.lastError = String(error?.message || error);
    await setState(state);
  });
}

async function persist(kind, record) {
  const id = await enqueue(kind, record);
  try {
    await postEnvelope({ id, kind, record });
    await markEnvelopeSaved(id);
  } catch (error) {
    await markOffline(error);
  }
}

async function persistCaptureWithoutLocalQueue(record) {
  try {
    await postEnvelope({ id: envelopeId("capture", record), kind: "capture", record });
    await withStorage(async () => {
      const state = await getState();
      state.serverOnline = true;
      state.stats.saved += 1;
      state.stats.lastError = null;
      await setState(state);
    });
  } catch (error) {
    await markOffline(error);
  }
}

function sensitiveEventKeys(eventIds) {
  return eventIds.flatMap((id) => [
    `event:${id}`, `decision:${id}`, `action:${id}`, `disposal:${id}`, `disposal-error:${id}`,
    `ledger:${id}`, `reporting-error:${id}`
  ]);
}

async function pruneSensitiveCache() {
  return withStorage(async () => {
    const state = await getState();
    const cutoff = Date.now() - SENSITIVE_CACHE_RETENTION_MS;
    const expired = state.eventIds.filter((id) => Number(state.eventOrder[id]?.cachedAt || 0) < cutoff);
    if (!expired.length) return;
    const expiredSet = new Set(expired);
    state.eventIds = state.eventIds.filter((id) => !expiredSet.has(id));
    for (const id of expired) delete state.eventOrder[id];
    await chrome.storage.local.remove(sensitiveEventKeys(expired));
    await setState(state);
  });
}

async function flushPending() {
  const state = await getState();
  for (const id of [...state.outboxIds]) {
    const stored = await chrome.storage.local.get(`outbox:${id}`);
    const envelope = stored[`outbox:${id}`];
    if (!envelope) {
      await markEnvelopeSaved(id);
      continue;
    }
    try {
      await postEnvelope(envelope);
      await markEnvelopeSaved(id);
    } catch (error) {
      await markOffline(error);
      break;
    }
  }
}

async function saveEvent(event) {
  await withStorage(async () => {
    const state = await getState();
    if (!state.eventIds.includes(event.eventId)) {
      state.stats.events += 1;
    }
    state.eventOrder[event.eventId] = {
      priority: alarmSourcePriority(event),
      time: alarmEventTime(event),
      cachedAt: Date.now()
    };
    state.eventIds = [event.eventId, ...state.eventIds.filter((id) => id !== event.eventId)]
      .sort((left, right) => {
        const a = state.eventOrder[left] || {};
        const b = state.eventOrder[right] || {};
        return compareAlarmOrder(a, b);
      });
    const removedEventIds = state.eventIds.slice(MAX_EVENTS);
    state.eventIds = state.eventIds.slice(0, MAX_EVENTS);
    const retained = new Set(state.eventIds);
    for (const id of Object.keys(state.eventOrder)) if (!retained.has(id)) delete state.eventOrder[id];
    if (removedEventIds.length) await chrome.storage.local.remove(sensitiveEventKeys(removedEventIds));
    await chrome.storage.local.set({ [`event:${event.eventId}`]: event });
    await setState(state);
  });
  await persist("event", event);
}

function eventWithState(event, stateName) {
  return { ...event, state: stateName, updatedAt: new Date().toISOString() };
}

async function updateEventState(event, stateName) {
  const updated = { ...event, state: stateName, updatedAt: new Date().toISOString() };
  await saveEvent(updated);
  return updated;
}

function actionPermissionBlockers(identity, enterpriseAccess, platformSession = null, mode = "DRY_RUN") {
  const blockers = [];
  if (!identity?.authenticated) blockers.push("未登录实名助手账号");
  else {
    if (!(identity.permissions || []).includes("action.execute")) blockers.push("当前角色没有动作执行权限");
    if (!identity.activeShift) blockers.push("未认领当前值班班次");
  }
  if (enterpriseAccess.status !== "ALLOWED") {
    blockers.push(enterpriseAccess.status === "OUT_OF_SCOPE" ? "报警企业不在当前授权范围" : "报警企业范围无法确认");
  }
  const sessionBlocker = platformSessionBlocker(platformSession, mode);
  if (sessionBlocker) blockers.push(sessionBlocker);
  return blockers;
}

async function processCaptureFastLocked(record, senderTabId, receivedAt = null) {
  const startedAt = performance.now();
  const candidates = extractAlarmCandidates(record);
  const incomingEvents = candidates.map((row) => normalizeAlarmRow(row, record));
  const eventIds = [...new Set(incomingEvents.map((event) => event.eventId))];
  const eventKeys = eventIds.flatMap((eventId) => [`event:${eventId}`, `decision:${eventId}`, `action:${eventId}`]);
  const context = await getCachedRuntimeContext(eventKeys);
  const { stored, identity, ruleSet, audioAssets, responseAssets, settings } = context;
  const state = context.state;
  const localValues = { ...stored };
  const updates = {};
  const processed = new Map();
  const scheduledActions = [];
  state.stats.captured += 1;
  if (record.isAlarm) state.stats.alarms += 1;
  state.stats.lastCaptureAt = record.capturedAt;
  state.stats.lastCaptureReceivedAt = receivedAt || new Date().toISOString();
  state.stats.lastRule = record.matchedRule;
  state.platformSession = platformSessionFromCapture(state.platformSession, record);
  if ([401, 403].includes(record.status)) state.stats.lastError = `省平台登录已失效：HTTP ${record.status}；真实动作已暂停，请人工重新登录`;
  else if (state.platformSession.status === "AUTHENTICATED" && /^省平台登录/.test(state.stats.lastError || "")) state.stats.lastError = null;

  for (const incoming of incomingEvents) {
    let scheduledAction = null;
    const key = `event:${incoming.eventId}`;
    let event = mergeAlarmEvents(localValues[key], incoming);
    const enterpriseAccess = enterpriseAccessForEvent(event, identity.enterpriseScopes || []);
    event.enterpriseAccess = enterpriseAccess;
    const decisionKey = `decision:${event.eventId}`;
    const actionKey = `action:${event.eventId}`;
    const existingDecision = localValues[decisionKey] || null;
    const existingAction = localValues[actionKey] || null;
    const freezeHistoricalDecision = existingDecision && (existingDecision.ruleSetVersion !== ruleSet.version || existingAction);
    let decision = freezeHistoricalDecision ? existingDecision : evaluateRules(event, ruleSet);
    const completionAssessment = evaluateCompletion(event, decision?.reminderPolicy || decision);
    decision = { ...decision, completionAssessment };
    event = { ...event, completionAssessment };
    const permissionBlockers = actionPermissionBlockers(identity, enterpriseAccess, state.platformSession, settings.mode);
    if (!freezeHistoricalDecision && ["AUTO_VOICE", "RESPONSE_PLAN"].includes(decision.action) && permissionBlockers.length) {
      decision = {
        ...decision,
        action: "MANUAL_REVIEW",
        originalAction: decision.action,
        reason: `${decision.reason}；安全闸门：${permissionBlockers.join("；")}`,
        permissionBlockers
      };
    }
    event = eventWithState(event, "RULE_MATCHED");
    updates[decisionKey] = decision;
    localValues[decisionKey] = decision;
    if (!existingDecision) {
      if (["AUTO_VOICE", "RESPONSE_PLAN"].includes(decision.action)) state.stats.autoVoice += 1;
      else if (decision.action === "RECORD_ONLY") state.stats.recordOnly += 1;
      else state.stats.manual += 1;
    }

    let action = null;
    if (decision.action === "RESPONSE_PLAN") {
      action = existingAction;
      if (action) {
        const preservedState = action.status === "SUCCEEDED" ? "SUCCEEDED" : ["FAILED", "UNKNOWN", "BLOCKED", "MANUAL_REQUIRED"].includes(action.status) ? "MANUAL_REQUIRED" : "EXECUTING";
        event = eventWithState(event, preservedState);
      } else {
        action = createResponsePlan(event, decision, settings, responseAssets);
        updates[actionKey] = action;
        localValues[actionKey] = action;
        if (action.status === "PLANNED") {
          event = eventWithState(event, "PLANNED");
          scheduledAction = { event, decision, action, senderTabId };
        } else {
          event = eventWithState(event, "MANUAL_REQUIRED");
        }
      }
    } else if (decision.action === "AUTO_VOICE") {
      action = existingAction;
      if (action) {
        const preservedState = action.status === "SUCCEEDED" ? "SUCCEEDED" : ["FAILED", "UNKNOWN", "BLOCKED"].includes(action.status) ? "MANUAL_REQUIRED" : "EXECUTING";
        event = eventWithState(event, preservedState);
      } else {
        action = createActionAttempt(event, decision, settings, audioAssets[decision.audioAssetId]);
        updates[actionKey] = action;
        localValues[actionKey] = action;
        if (action.status === "PLANNED") {
          event = eventWithState(event, "PLANNED");
          scheduledAction = { event, decision, action, senderTabId };
        } else {
          event = eventWithState(event, "MANUAL_REQUIRED");
        }
      }
    } else if (decision.action === "RECORD_ONLY") {
      event = eventWithState(event, "RECORD_ONLY");
    } else {
      event = eventWithState(event, "MANUAL_REQUIRED");
    }
    updates[key] = event;
    localValues[key] = event;
    if (!state.eventIds.includes(event.eventId)) state.stats.events += 1;
    state.eventOrder[event.eventId] = { priority: alarmSourcePriority(event), time: alarmEventTime(event), cachedAt: Date.now() };
    state.eventIds = [event.eventId, ...state.eventIds.filter((id) => id !== event.eventId)];
    processed.set(event.eventId, { event, decision, action, enterpriseAccess });
    if (scheduledAction) scheduledActions.push(scheduledAction);
  }

  state.eventIds.sort((left, right) => compareAlarmOrder(state.eventOrder[left] || {}, state.eventOrder[right] || {}));
  const removedEventIds = state.eventIds.slice(MAX_EVENTS);
  state.eventIds = state.eventIds.slice(0, MAX_EVENTS);
  const retained = new Set(state.eventIds);
  for (const id of Object.keys(state.eventOrder)) if (!retained.has(id)) delete state.eventOrder[id];
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  state.stats.lastDecisionLatencyMs = latencyMs;
  state.stats.maxDecisionLatencyMs = Math.max(Number(state.stats.maxDecisionLatencyMs || 0), latencyMs);
  state.stats.lastUiReadyAt = new Date().toISOString();
  state.stats.backgroundPending = Number(state.stats.backgroundPending || 0) + 1;
  updates[STATE_KEY] = state;
  await chrome.storage.local.set(updates);
  if (removedEventIds.length) await chrome.storage.local.remove(sensitiveEventKeys(removedEventIds));
  return { items: [...processed.values()], scheduledActions, latencyMs };
}

async function processCaptureFast(record, senderTabId, receivedAt = null) {
  return withStorage(() => processCaptureFastLocked(record, senderTabId, receivedAt));
}

async function syncManualDisposal(item, identity) {
  const { event, decision, action, enterpriseAccess } = item;
  const completionNeedsManual = action?.status === "SUCCEEDED"
    && ["UNKNOWN_MANUAL", "PLATFORM_ACTIVE"].includes(event?.completionAssessment?.status);
  if (!(decision.action === "MANUAL_REVIEW" || action?.status === "BLOCKED" || completionNeedsManual)) return;
  if (!["REALTIME", "TECHNICAL", "PENDING"].includes(event.sourceKind) || enterpriseAccess.status !== "ALLOWED" || !identity.authenticated || !identity.activeShift) return;
  try {
    const disposalDecision = decision.action === "MANUAL_REVIEW" ? decision : {
      ...decision,
      originalAction: decision.action,
      action: "MANUAL_REVIEW",
      reason: completionNeedsManual
        ? `${decision.reason}；司机提醒后省平台未确认报警已解除：${event.completionAssessment.reason}`
        : `${decision.reason}；响应计划被安全闸门阻断：${(action?.blockers || []).join("；")}`,
    };
    const disposal = await assistantMutation("/disposals/api/cases/upsert", { event, decision: disposalDecision }, identity);
    await chrome.storage.local.set({ [`disposal:${event.eventId}`]: disposal.data });
    await chrome.storage.local.remove(`disposal-error:${event.eventId}`);
  } catch (error) {
    await chrome.storage.local.set({ [`disposal-error:${event.eventId}`]: String(error?.message || error) });
    await audit("DISPOSAL_SYNC_FAILED", { eventId: event.eventId, error: String(error?.message || error), actorUserId: identity.userId });
  }
}

async function completeCaptureInBackground(record, result) {
  let failed = false;
  try {
    const identity = await getAssistantIdentity();
    const scheduledByEvent = new Map(result.scheduledActions.map((item) => [item.event.eventId, item]));
    const actionPromises = [];
    // Raw captures can contain full platform JSON. Never place them in browser storage.
    await persistCaptureWithoutLocalQueue(record);
    const orderedItems = [...result.items].sort((left, right) => Number(scheduledByEvent.has(right.event.eventId)) - Number(scheduledByEvent.has(left.event.eventId)));
    for (const item of orderedItems) {
      await persist("event", item.event);
      await persist("decision", item.decision);
      if (item.action) await persist("action", item.action);
      await persistLedger(item.event, item.decision, item.action);
      await syncAlarmFact(item.event, item.decision, item.action, identity);
      await syncManualDisposal(item, identity);
      const scheduled = scheduledByEvent.get(item.event.eventId);
      if (scheduled) actionPromises.push(executeScheduledAction(scheduled));
    }
    const actionResults = await Promise.allSettled(actionPromises);
    failed = actionResults.some((item) => item.status === "rejected");
  } catch (error) {
    failed = true;
    await audit("CAPTURE_BACKGROUND_FAILED", { error: String(error?.message || error).slice(0, 300) });
  } finally {
    await withStorage(async () => {
      const state = await getState();
      state.stats.backgroundPending = Math.max(0, Number(state.stats.backgroundPending || 0) - 1);
      if (failed) state.stats.backgroundFailed = Number(state.stats.backgroundFailed || 0) + 1;
      await setState(state);
    });
  }
}

async function bumpTreatmentStat(action) {
  await withStorage(async () => {
    const state = await getState();
    if (["AUTO_VOICE", "RESPONSE_PLAN"].includes(action)) state.stats.autoVoice += 1;
    else if (action === "RECORD_ONLY") state.stats.recordOnly += 1;
    else state.stats.manual += 1;
    await setState(state);
  });
}

async function choosePrimaryTab(senderTabId) {
  const state = await getState();
  if (state.primaryTabId != null) {
    try {
      await chrome.tabs.get(state.primaryTabId);
      return state.primaryTabId;
    } catch {}
  }
  if (senderTabId != null) {
    state.primaryTabId = senderTabId;
    await setState(state);
    return senderTabId;
  }
  const tabs = await chrome.tabs.query({ url: ["https://*.hnznjg.cn:7443/*", "http://127.0.0.1:18080/*", "http://localhost:18080/*"] });
  state.primaryTabId = tabs[0]?.id ?? null;
  await setState(state);
  return state.primaryTabId;
}

async function chooseHnPlatformTab(allowedTargets = KEEPALIVE_TARGETS) {
  const state = await getState();
  const tabs = await chrome.tabs.query({ url: ["https://*.hnznjg.cn:7443/*"] });
  const targetRoutes = new Map((allowedTargets || []).map((target, index) => [String(target.route || ""), index]));
  const eligible = tabs.filter((item) => {
    if (!isHnPlatformUrl(item.url)) return false;
    try { return targetRoutes.has(new URL(item.url).hash.split("?")[0]); } catch { return false; }
  });
  eligible.sort((left, right) => {
    if (Boolean(left.active) !== Boolean(right.active)) return left.active ? -1 : 1;
    const leftHash = (() => { try { return new URL(left.url).hash.split("?")[0]; } catch { return ""; } })();
    const rightHash = (() => { try { return new URL(right.url).hash.split("?")[0]; } catch { return ""; } })();
    return (targetRoutes.get(leftHash) ?? 999) - (targetRoutes.get(rightHash) ?? 999);
  });
  const tab = eligible[0] || null;
  if (tab?.id != null) {
    state.primaryTabId = tab.id;
    await setState(state);
  }
  return tab;
}

async function fetchKeepalivePolicy() {
  const response = await fetch(await assistantUrl("/governance/api/session-keepalive/policy"), {
    credentials: "include", cache: "no-store", headers: { accept: "application/json" }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload?.data) throw new Error(payload?.message || `保活策略 HTTP ${response.status}`);
  const policy = payload.data;
  if (policy.targetRoute !== "#/alarm-center/alarm-preprocessing" || policy.targetActionKey !== "ALARM_PREPROCESSING_QUERY") {
    throw new Error("服务器保活策略超出扩展固定授权范围");
  }
  const configuredTargets = Array.isArray(policy.allowedTargets) ? policy.allowedTargets : [];
  const expectedTargets = JSON.stringify(KEEPALIVE_TARGETS);
  const receivedTargets = JSON.stringify(configuredTargets.map((target) => ({
    route: String(target?.route || ""), actionKey: String(target?.actionKey || ""), mode: String(target?.mode || ""),
  })));
  if (receivedTargets !== expectedTargets) throw new Error("服务器多页面保活目标超出扩展固定授权范围");
  if (!Number.isInteger(policy.intervalMinutes) || policy.intervalMinutes < 20 || policy.intervalMinutes > 50) throw new Error("服务器保活间隔无效");
  await withStorage(async () => {
    const state = await getState();
    state.keepalive.policy = policy;
    await setState(state);
  });
  return policy;
}

async function scheduleNextKeepalive(policy, { retry = false } = {}) {
  const intervalMs = (retry ? KEEPALIVE_POLICY_RETRY_MINUTES : policy?.enabled ? policy.intervalMinutes : KEEPALIVE_POLICY_RETRY_MINUTES) * 60 * 1000;
  const jitterMs = Math.floor(Math.random() * 120 * 1000);
  const when = Date.now() + intervalMs + jitterMs;
  chrome.alarms.create(KEEPALIVE_ALARM, { when });
  await withStorage(async () => {
    const state = await getState();
    state.keepalive.nextScheduledAt = new Date(when).toISOString();
    await setState(state);
  });
}

async function updateKeepaliveResult(code, { policy = null, latencyMs = 0, route = "" } = {}) {
  const attemptedAt = new Date().toISOString();
  await withStorage(async () => {
    const state = await getState();
    state.keepalive.lastAttemptAt = attemptedAt;
    state.keepalive.lastResultCode = code;
    state.keepalive.lastLatencyMs = latencyMs;
    if (code === "SUCCESS") state.keepalive.lastSuccessAt = attemptedAt;
    if (policy) state.keepalive.policy = policy;
    await setState(state);
  });
  return { attemptedAt, route };
}

async function submitKeepaliveAudit(identity, policy, result, attemptedAt) {
  if (!identity?.authenticated || !identity.activeShift || !(identity.permissions || []).includes("session.keepalive.execute")) return;
  try {
    await assistantMutation("/governance/api/session-keepalive/audits", {
      deviceId: await getDeviceId(), policyVersion: Number(policy?.version || 0), attemptedAt,
      route: String(result.route || "").slice(0, 200), resultCode: result.code, latencyMs: Number(result.latencyMs || 0),
    }, identity);
  } catch (error) {
    await audit("SESSION_KEEPALIVE_AUDIT_SYNC_FAILED", { code: result.code, error: String(error?.message || error).slice(0, 300) });
  }
}

let keepaliveExecution = null;
async function performAuthorizedKeepalive() {
  if (keepaliveExecution) {
    await updateKeepaliveResult("OVERLAP_SKIPPED");
    return;
  }
  keepaliveExecution = (async () => {
    const started = Date.now();
    let policy = null;
    let identity = null;
    let result = { code: "POLICY_UNAVAILABLE", route: "", latencyMs: 0 };
    try {
      identity = await getAssistantIdentity({ force: true });
      if (!identity.authenticated) result = { ...result, code: "IDENTITY_REQUIRED" };
      else if (!identity.activeShift) result = { ...result, code: "SHIFT_REQUIRED" };
      else if (!(identity.permissions || []).includes("session.keepalive.execute")) result = { ...result, code: "PERMISSION_DENIED" };
      else {
        policy = await fetchKeepalivePolicy();
        if (!policy.enabled) result = { ...result, code: "DISABLED" };
        else {
          const state = await getState();
          const lastSuccess = Date.parse(state.keepalive.lastSuccessAt || "") || 0;
          if (lastSuccess && Date.now() - lastSuccess < Math.max(20, policy.intervalMinutes - 2) * 60 * 1000) {
            result = { ...result, code: "COOLDOWN_ACTIVE" };
          } else {
            const tab = await chooseHnPlatformTab(policy.allowedTargets);
            if (!tab?.id) result = { ...result, code: "PLATFORM_TAB_NOT_FOUND" };
            else result = await chrome.tabs.sendMessage(tab.id, { type: "AUTHORIZED_KEEPALIVE_EXECUTE", policyVersion: policy.version });
          }
        }
      }
    } catch (error) {
      result = { ...result, code: "POLICY_UNAVAILABLE", error: String(error?.message || error).slice(0, 300) };
    }
    result.latencyMs = Number(result.latencyMs || Date.now() - started);
    const saved = await updateKeepaliveResult(result.code, { policy, latencyMs: result.latencyMs, route: result.route });
    await submitKeepaliveAudit(identity, policy, result, saved.attemptedAt);
    await audit("AUTHORIZED_SESSION_KEEPALIVE", { resultCode: result.code, route: result.route || "", latencyMs: result.latencyMs, policyVersion: policy?.version || null });
    await scheduleNextKeepalive(policy, { retry: !policy });
  })();
  try { await keepaliveExecution; } finally { keepaliveExecution = null; }
}

async function sendDeviceHeartbeat() {
  const identity = await getAssistantIdentity({ force: true });
  if (!identity.authenticated || !identity.activeShift || !(identity.permissions || []).includes("session.keepalive.execute")) return;
  const state = await getState();
  await assistantMutation("/governance/api/devices/heartbeat", {
    deviceId: await getDeviceId(), extensionVersion: chrome.runtime.getManifest().version,
    platformAccountRef: identity.activeShift.platformAccountRef, sessionStatus: state.platformSession.status,
    route: state.platformSession.route || "",
    platformContext: {
      displayName: state.platformSession.platformDisplayName || "",
      identityStatus: state.platformSession.platformIdentityStatus || "UNKNOWN",
      visibleScopeHash: state.platformSession.platformVisibleScopeHash || "",
      permissionSummary: state.platformSession.platformPermissionSummary || {}
    }
  }, identity);
}

async function executeScheduledAction(item) {
  return item.action?.type === "RESPONSE_PLAN"
    ? executeResponsePlan(item.event, item.decision, item.action, item.senderTabId)
    : executeAction(item.event, item.decision, item.action, item.senderTabId);
}

async function executeResponseAttempt(original, event, senderTabId) {
  if (original.status === "BLOCKED") {
    const blocked = {
      ...original,
      deliveries: [{ status: "BLOCKED", blockers: original.blockers || [], attemptNumber: 1 }],
      retryCount: 0,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persist("action", blocked);
    return blocked;
  }
  const startedAt = new Date().toISOString();
  const result = await executeWithRetry(async (attemptNumber) => {
    let delivery = { ...original, status: "EXECUTING", attemptNumber, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await persist("action", delivery);
    if (delivery.mode === "DRY_RUN") {
      delivery = { ...delivery, status: "SUCCEEDED", result: { simulated: true, receiptId: `dry-run-${delivery.actionId}-${attemptNumber}`, message: `${delivery.channelType} 演练完成，未连接真实车辆` } };
    } else if (delivery.mode === "SANDBOX" && delivery.channelType === "TEXT") {
      delivery = { ...delivery, ...(await executeSandboxText({ event, action: delivery })) };
    } else if (delivery.mode === "SANDBOX" && delivery.channelType === "VOICE") {
      delivery = { ...delivery, ...(await executeSandboxIntercom({ event, action: { ...delivery, audioAssetId: delivery.assetKey } })) };
    } else if (delivery.mode === "LIVE") {
      delivery = { ...delivery, ...(await executeLivePlatformAttempt(delivery, event, senderTabId)) };
    } else {
      delivery = { ...delivery, status: "BLOCKED", blockers: [...(delivery.blockers || []), "真实渠道执行适配器未获授权"] };
    }
    delivery = { ...delivery, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await persist("action", delivery);
    return delivery;
  }, original.retryPolicy);
  const attempt = { ...original, ...result, startedAt, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persist("action", attempt);
  return attempt;
}

async function skippedResponseAttempt(original, reason) {
  const skipped = { ...original, status: "SKIPPED", blockers: [...(original.blockers || []), reason], finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persist("action", skipped);
  return skipped;
}

async function executeResponsePlan(event, decision, plan, senderTabId) {
  const identity = await getAssistantIdentity({ force: true });
  const enterpriseAccess = enterpriseAccessForEvent(event, identity.enterpriseScopes || []);
  const platformSession = (await getState()).platformSession;
  const permissionBlockers = actionPermissionBlockers(identity, enterpriseAccess, platformSession, plan.mode);
  if (permissionBlockers.length) {
    return finishResponsePlan(event, decision, { ...plan, status: "BLOCKED", blockers: permissionBlockers, finishedAt: new Date().toISOString() }, identity);
  }
  let serverLease = null;
  if (plan.mode === "LIVE") {
    try {
      serverLease = await acquireServerActionLease(event, plan, identity);
    } catch (error) {
      return finishResponsePlan(event, decision, {
        ...plan,
        status: "BLOCKED",
        blockers: [...(plan.blockers || []), `服务器动作租约未取得：${error?.code || "SERVER_LEASE_FAILED"}`],
        finishedAt: new Date().toISOString(),
      }, identity);
    }
  }
  const vehicleKey = event.vehicleId || event.vehicleNo || event.eventId;
  const claimed = await withStorage(async () => {
    const state = await getState();
    if (state.activeVehicleActions[vehicleKey]) return false;
    state.activeVehicleActions[vehicleKey] = plan.actionId;
    await setState(state);
    return true;
  });
  if (!claimed) {
    return finishResponsePlan(event, decision, { ...plan, status: "BLOCKED", blockers: ["该车辆已有进行中的响应计划"], finishedAt: new Date().toISOString() }, identity, serverLease);
  }

  let currentPlan = { ...plan, serverLeaseId: serverLease?.leaseId || null, status: "EXECUTING", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [`action:${event.eventId}`]: currentPlan });
  await persist("action", currentPlan);
  event = await updateEventState(event, "EXECUTING");
  const ordered = [...currentPlan.attempts].sort((a, b) => Number(a.order) - Number(b.order));
  const strategy = currentPlan.channelStrategy || (ordered.length <= 1 ? "SINGLE" : "SEQUENTIAL");
  let attempts = [];
  let failed = false;
  let fallbackUsed = false;
  if (currentPlan.testPromotion === true && currentPlan.fallback === "TEXT_ON_VOICE_FAILURE") {
    const outcome = await executeVoiceThenTextFallback(ordered, {
      execute: (attempt) => executeResponseAttempt(attempt, event, senderTabId),
      skip: skippedResponseAttempt,
    });
    attempts = outcome.attempts;
    fallbackUsed = outcome.fallbackUsed;
    failed = outcome.failed;
  } else if (strategy === "PARALLEL") {
    attempts = await Promise.all(ordered.map((attempt) => executeResponseAttempt(attempt, event, senderTabId)));
    failed = attempts.some((attempt) => attempt.status !== "SUCCEEDED");
  } else if (strategy === "FALLBACK") {
    let resolved = false;
    let stopForUnknown = false;
    for (const original of ordered) {
      if (resolved) {
        attempts.push(await skippedResponseAttempt(original, "前序渠道已明确成功，无需执行兜底渠道"));
      } else if (stopForUnknown) {
        attempts.push(await skippedResponseAttempt(original, "前序渠道结果未知或被安全阻断，禁止自动切换渠道"));
      } else {
        const attempt = await executeResponseAttempt(original, event, senderTabId);
        attempts.push(attempt);
        if (attempt.status === "SUCCEEDED") resolved = true;
        else if (["UNKNOWN", "BLOCKED"].includes(attempt.status)) stopForUnknown = true;
      }
    }
    failed = !resolved;
  } else {
    let stop = false;
    for (const original of ordered) {
      if (stop) attempts.push(await skippedResponseAttempt(original, "前序渠道未明确成功"));
      else {
        const attempt = await executeResponseAttempt(original, event, senderTabId);
        attempts.push(attempt);
        if (attempt.status !== "SUCCEEDED") stop = true;
      }
    }
    failed = attempts.some((attempt) => !["SUCCEEDED", "SKIPPED"].includes(attempt.status));
  }
  currentPlan = {
    ...currentPlan,
    attempts,
    status: failed ? "MANUAL_REQUIRED" : "SUCCEEDED",
    processingStatus: failed
      ? fallbackUsed ? "PROCESSED_WITH_FALLBACK" : "MANUAL_REQUIRED"
      : "PROCESSED",
    fallbackUsed,
    blockers: attempts.flatMap((attempt) => [
      ...(attempt.blockers || []).map((blocker) => `${attempt.channelType}: ${blocker}`),
      ...(attempt.error ? [`${attempt.channelType}: ${attempt.error}`] : []),
    ]),
    finishedAt: new Date().toISOString(),
  };
  return finishResponsePlan(event, decision, currentPlan, identity, serverLease);
}

async function finishResponsePlan(event, decision, plan, identity, serverLease = null) {
  plan = { ...plan, updatedAt: new Date().toISOString() };
  await withStorage(async () => {
    const state = await getState();
    const vehicleKey = event.vehicleId || event.vehicleNo || event.eventId;
    if (state.activeVehicleActions[vehicleKey] === plan.actionId) delete state.activeVehicleActions[vehicleKey];
    if (plan.status !== "SUCCEEDED") state.stats.failedActions += 1;
    await chrome.storage.local.set({ [`action:${event.eventId}`]: plan });
    await setState(state);
  });
  await persist("action", plan);
  const finalState = plan.status === "SUCCEEDED" ? "SUCCEEDED" : "MANUAL_REQUIRED";
  const updatedEvent = await updateEventState(event, finalState);
  await persistLedger(updatedEvent, decision, plan);
  await syncAlarmFact(updatedEvent, decision, plan, identity);
  await reportServerActionResult(serverLease, plan, identity);
  if (plan.status !== "SUCCEEDED" && identity?.authenticated && identity.activeShift && enterpriseAccessForEvent(updatedEvent, identity.enterpriseScopes || []).status === "ALLOWED") {
    try {
      const manualDecision = { ...decision, originalAction: decision.action, action: "MANUAL_REVIEW", reason: `${decision.reason}；响应计划未完成：${(plan.blockers || []).join("；")}` };
      const disposal = await assistantMutation("/disposals/api/cases/upsert", { event: updatedEvent, decision: manualDecision }, identity);
      await chrome.storage.local.set({ [`disposal:${event.eventId}`]: disposal.data });
    } catch (error) {
      await chrome.storage.local.set({ [`disposal-error:${event.eventId}`]: String(error?.message || error) });
    }
  }
  return plan;
}

async function executeAction(event, decision, action, senderTabId) {
  const identity = await getAssistantIdentity({ force: true });
  const enterpriseAccess = enterpriseAccessForEvent(event, identity.enterpriseScopes || []);
  const platformSession = (await getState()).platformSession;
  const permissionBlockers = actionPermissionBlockers(identity, enterpriseAccess, platformSession, action.mode);
  if (permissionBlockers.length) {
    return finishAction(event, decision, { ...action, status: "BLOCKED", blockers: permissionBlockers, finishedAt: new Date().toISOString() });
  }
  let serverLease = null;
  if (action?.type === "VOICE_INTERCOM" && action.mode === "LIVE") {
    try {
      serverLease = await acquireServerActionLease(event, action, identity);
    } catch (error) {
      return finishAction(event, decision, {
        ...action,
        status: "BLOCKED",
        blockers: [...(action.blockers || []), `服务器动作租约未取得：${error?.code || "SERVER_LEASE_FAILED"}`],
        finishedAt: new Date().toISOString(),
      }, serverLease);
    }
  }
  const vehicleKey = event.vehicleId || event.vehicleNo || event.eventId;
  const claimed = await withStorage(async () => {
    const state = await getState();
    if (state.activeVehicleActions[vehicleKey]) return false;
    state.activeVehicleActions[vehicleKey] = action.actionId;
    await setState(state);
    return true;
  });
  if (!claimed) {
    return finishAction(event, decision, { ...action, status: "BLOCKED", blockers: ["该车辆已有进行中的对讲动作"] }, serverLease);
  }
  const executing = { ...action, status: "EXECUTING", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [`action:${event.eventId}`]: executing });
  await persist("action", executing);
  event = await updateEventState(event, "EXECUTING");
  if (action.mode === "DRY_RUN") {
    return finishAction(event, decision, {
      ...executing,
      status: "SUCCEEDED",
      finishedAt: new Date().toISOString(),
      result: { simulated: true, message: "演练完成，未连接真实车辆" }
    }, serverLease);
  }
  if (action.mode === "SANDBOX") {
    const sandboxResult = await executeSandboxIntercom({ event, action });
    return finishAction(event, decision, { ...executing, ...sandboxResult, finishedAt: new Date().toISOString() }, serverLease);
  }
  const tabId = await choosePrimaryTab(senderTabId);
  if (tabId == null) return finishAction(event, decision, { ...executing, status: "FAILED", error: "没有可执行对讲的省平台页面" }, serverLease);
  return finishAction(event, decision, {
    ...executing,
    status: "BLOCKED",
    finishedAt: new Date().toISOString(),
    blockers: ["真实对讲执行适配器尚未获得客户授权并完成测试车辆联调，本次构建不会调用平台动作接口"]
  }, serverLease);
}

async function finishAction(event, decision, action, serverLease = null) {
  action = { ...action, updatedAt: new Date().toISOString() };
  await withStorage(async () => {
    const state = await getState();
    const vehicleKey = event.vehicleId || event.vehicleNo || event.eventId;
    if (state.activeVehicleActions[vehicleKey] === action.actionId) delete state.activeVehicleActions[vehicleKey];
    if (["FAILED", "UNKNOWN", "BLOCKED"].includes(action.status)) state.stats.failedActions += 1;
    await chrome.storage.local.set({ [`action:${event.eventId}`]: action });
    await setState(state);
  });
  await persist("action", action);
  const finalState = action.status === "SUCCEEDED" ? "SUCCEEDED" : "MANUAL_REQUIRED";
  const updatedEvent = await updateEventState(event, finalState);
  await persistLedger(updatedEvent, decision, action);
  await syncAlarmFact(updatedEvent, decision, action, await getAssistantIdentity({ force: true }));
  await reportServerActionResult(serverLease, action, await getAssistantIdentity({ force: true }));
  return action;
}

async function syncAlarmFact(event, decision, action, identity) {
  if (!identity?.authenticated || !identity.activeShift || !(identity.permissions || []).includes("alarm.view")) return;
  try {
    // 只读报警事实全部交给 Django 做企业权限校验和全局 event_id 去重；
    // 浏览器范围判断仅用于界面展示和真实动作闸门，不能替代服务器裁决。
    const state = await getState();
    const captureId = event.sourceCaptures?.at?.(-1) || event.eventId;
    const response = await assistantMutation("/reports/api/events/upsert", {
      event, decision, action,
      source: {
        captureId, deviceId: await getDeviceId(), platformAccountRef: identity.activeShift?.platformAccountRef || "",
        extensionVersion: chrome.runtime.getManifest().version, endpoint: String(event.rawEndpoint || "").slice(0, 300),
        capturedAt: event.updatedAt || event.discoveredAt || new Date().toISOString(),
      }
    }, identity);
    if (response?.data?.processingStatus) {
      await chrome.storage.local.set({ [`processing:${event.eventId}`]: {
        status: response.data.processingStatus,
        source: response.data.processingSource || null,
        markedAt: response.data.processingMarkedAt || null,
      } });
    }
    await chrome.storage.local.remove(`reporting-error:${event.eventId}`);
  } catch (error) {
    await chrome.storage.local.set({ [`reporting-error:${event.eventId}`]: String(error?.message || error) });
    await audit("REPORTING_SYNC_FAILED", { eventId: event.eventId, error: String(error?.message || error), actorUserId: identity.userId });
  }
}

async function persistLedger(event, decision, action) {
  const row = toLedgerRow(event, decision, action);
  row.auditId = `ledger:${event.eventId}`;
  await chrome.storage.local.set({ [`ledger:${event.eventId}`]: row });
  await persist("ledger", row);
}

async function recentEvents(identity, limit = 100) {
  if (!identity?.authenticated || !(identity.permissions || []).includes("alarm.view")) return [];
  const state = await getState();
  const ids = state.eventIds.slice(0, limit);
  const keys = ids.flatMap((id) => [`event:${id}`, `decision:${id}`, `action:${id}`, `processing:${id}`, `disposal:${id}`, `disposal-error:${id}`]);
  const stored = await chrome.storage.local.get(keys);
  return ids.map((id) => ({ event: stored[`event:${id}`], decision: stored[`decision:${id}`] || null, action: stored[`action:${id}`] || null, processing: stored[`processing:${id}`] || null, disposal: stored[`disposal:${id}`] || null, disposalSyncError: stored[`disposal-error:${id}`] || null }))
    .filter((item) => item.event && enterpriseAccessForEvent(item.event, identity.enterpriseScopes || []).status === "ALLOWED");
}

function requireEventEnterpriseAccess(identity, event) {
  const access = enterpriseAccessForEvent(event, identity.enterpriseScopes || []);
  if (access.status !== "ALLOWED") throw new Error("该报警不在当前实名用户的企业授权范围内");
  return access;
}

function scopedStats(state, events) {
  return {
    ...state.stats,
    events: events.length,
    manual: events.filter((item) => item.decision?.action === "MANUAL_REVIEW").length,
    autoVoice: events.filter((item) => ["AUTO_VOICE", "RESPONSE_PLAN"].includes(item.decision?.action)).length,
    recordOnly: events.filter((item) => item.decision?.action === "RECORD_ONLY").length,
    failedActions: events.filter((item) => ["FAILED", "UNKNOWN", "BLOCKED"].includes(item.action?.status)).length,
  };
}

async function audit(type, detail) {
  const record = { auditId: `audit:${crypto.randomUUID()}`, type, detail, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persist("audit", record);
}

async function updatePlatformSession(report, senderTabId) {
  let transition = null;
  const session = await withStorage(async () => {
    const state = await getState();
    const previous = state.platformSession;
    const next = normalizePlatformSession(previous, report);
    if (senderTabId != null) state.primaryTabId = senderTabId;
    state.platformSession = next;
    if (next.status === "LOGIN_REQUIRED") {
      state.stats.lastError = "省平台已自动退出；真实动作已暂停，请人工重新登录后刷新实时报警和技术检测";
    } else if (next.status === "AUTHENTICATED" && /^省平台(已自动退出|登录)/.test(state.stats.lastError || "")) {
      state.stats.lastError = null;
    }
    if (previous.status !== next.status) transition = { from: previous.status, to: next.status, route: next.route, reason: next.reason };
    await setState(state);
    return next;
  });
  if (transition) await audit(transition.to === "LOGIN_REQUIRED" ? "PLATFORM_SESSION_EXPIRED" : "PLATFORM_SESSION_CHANGED", transition);
  return session;
}

async function recoverInterruptedResponsePlans() {
  const state = await getState();
  const keys = state.eventIds.flatMap((eventId) => [`event:${eventId}`, `decision:${eventId}`, `action:${eventId}`]);
  if (!keys.length) return;
  const stored = await chrome.storage.local.get(keys);
  const identity = await getAssistantIdentity();
  for (const eventId of state.eventIds) {
    const event = stored[`event:${eventId}`];
    const decision = stored[`decision:${eventId}`];
    const plan = stored[`action:${eventId}`];
    if (!event || !decision || plan?.type !== "RESPONSE_PLAN" || !["PLANNED", "EXECUTING"].includes(plan.status)) continue;
    const finishedAt = new Date().toISOString();
    const attempts = (plan.attempts || []).map((attempt) => ["PLANNED", "EXECUTING"].includes(attempt.status) ? {
      ...attempt,
      status: "UNKNOWN",
      error: "扩展后台在动作完成前中断，结果未知；按规则禁止自动重试",
      finishedAt,
      updatedAt: finishedAt,
    } : attempt);
    await finishResponsePlan(event, decision, {
      ...plan,
      attempts,
      status: "MANUAL_REQUIRED",
      blockers: [...(plan.blockers || []), "扩展后台中断，动作结果未知，已停止自动重试并转人工"],
      finishedAt,
      updatedAt: finishedAt,
    }, identity);
  }
}

async function initialize() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, RULES_KEY, AUDIO_KEY]);
  const updates = {};
  if (!stored[SETTINGS_KEY]) updates[SETTINGS_KEY] = DEFAULT_SETTINGS;
  if (!stored[AUDIO_KEY]) updates[AUDIO_KEY] = {};
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  await pruneSensitiveCache();
  await migrateLegacyPreprocessingSources();
  await getDeviceId();
  await getRuleSet();
  await recoverInterruptedResponsePlans();
  chrome.alarms.create("flush-pending", { periodInMinutes: 1 });
  chrome.alarms.create(HEARTBEAT_ALARM, { delayInMinutes: 1 + Math.random(), periodInMinutes: 1 });
  chrome.alarms.create(REPORT_TASK_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  const keepaliveAlarm = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!keepaliveAlarm) {
    try { await scheduleNextKeepalive(await fetchKeepalivePolicy()); }
    catch { await scheduleNextKeepalive(null, { retry: true }); }
  }
}

async function migrateLegacyPreprocessingSources() {
  await withStorage(async () => {
    const state = await getState();
    const keys = state.eventIds.map((eventId) => `event:${eventId}`);
    if (!keys.length) return;
    const stored = await chrome.storage.local.get(keys);
    const updates = {};
    for (const key of keys) {
      const event = stored[key];
      if (!event || event.sourceKind !== "PREWARNING" || event.rawEndpoint !== "prewarning-alarms") continue;
      updates[key] = {
        ...event, sourceKind: "PENDING", sourceLabel: "待处理报警", rawEndpoint: "pending-alarms",
        sourceEndpoints: (event.sourceEndpoints || []).map((endpoint) => endpoint === "prewarning-alarms" ? "pending-alarms" : endpoint),
      };
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  });
}

chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "flush-pending") void Promise.allSettled([flushPending(), pruneSensitiveCache()]);
  if (alarm.name === HEARTBEAT_ALARM) void sendDeviceHeartbeat().catch((error) => audit("DEVICE_HEARTBEAT_FAILED", { error: String(error?.message || error).slice(0, 300) }));
  if (alarm.name === REPORT_TASK_ALARM) void monitorReportTasks();
  if (alarm.name === KEEPALIVE_ALARM) void performAuthorizedKeepalive();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  platformAuthCache.delete(tabId);
  void withStorage(async () => {
    const state = await getState();
    if (state.primaryTabId === tabId) state.primaryTabId = null;
    await setState(state);
  });
});

async function armAndExecuteSpeedingPrewarningTest(eventId, senderTabId, confirmed) {
  if (confirmed !== true) throw new Error("必须明确确认当前单条真实动作测试");
  const identity = await requireAssistantPermission("action.execute", { requireShift: true });
  const key = String(eventId || "");
  const stored = await chrome.storage.local.get([`event:${key}`, `decision:${key}`, `action:${key}`]);
  let event = stored[`event:${key}`];
  if (!event) throw new Error("当前报警事件不存在");
  requireEventEnterpriseAccess(identity, event);
  const previousAction = stored[`action:${key}`];
  if (previousAction?.testPromotion || previousAction?.status === "SUCCEEDED") {
    throw new Error("当前报警已经执行或尝试过单条测试，禁止重复下发");
  }
  const settings = await getSettings();
  if (settings.mode !== "LIVE") throw new Error("请先由系统管理员将插件运行模式设置为真实动作");
  const state = await getState();
  if (
    state.platformSession.status !== "AUTHENTICATED"
    || state.platformSession.route !== "#/vehicle-monitor/real-time"
    || !state.platformSession.platformDisplayName
  ) {
    throw new Error("当前省平台实时监控页登录身份尚未确认");
  }
  const decision = createSpeedingPrewarningTestDecision(event);
  await sendDeviceHeartbeat();
  await assistantMutation("/governance/api/devices/verify-platform-action", {
    deviceId: await getDeviceId(),
    platformDisplayName: state.platformSession.platformDisplayName,
    route: state.platformSession.route,
  }, identity);
  const approvedAt = new Date().toISOString();
  const nextSettings = {
    ...settings,
    prewarningTest: {
      targetEventId: event.eventId,
      approvedAt,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      consumedAt: approvedAt,
    },
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
  let action = createResponsePlan(event, decision, nextSettings, BUNDLED_SPEEDING_ASSETS);
  if (action.status !== "PLANNED") throw new Error(action.blockers.join("；") || "当前单条测试计划未通过安全检查");
  action = { ...action, initiatedBy: "DUTY_OPERATOR", initiatedByUserId: identity.userId };
  event = eventWithState({ ...event, testPromotion: true, effectiveActionKind: "TEST_FORMAL" }, "PLANNED");
  await chrome.storage.local.set({
    [`event:${event.eventId}`]: event,
    [`decision:${event.eventId}`]: decision,
    [`action:${event.eventId}`]: action,
  });
  await persist("event", event);
  await persist("decision", decision);
  await persist("action", action);
  await syncAlarmFact(event, decision, action, identity);
  await audit("SPEEDING_PREWARNING_SINGLE_TEST_ARMED", {
    eventId: event.eventId,
    actorUserId: identity.userId,
    expiresAt: nextSettings.prewarningTest.expiresAt,
  });
  const result = await executeResponsePlan(event, decision, action, senderTabId);
  return { ok: result.status === "SUCCEEDED", action: result, error: result.blockers?.join("；") || result.error || null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => { void promise.then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) })); return true; };
  if (message.type === "CAPTURE") {
    return respond(withProcessing(() => processCaptureFast(message.record, sender.tab?.id, message.receivedAt)).then((result) => {
      void completeCaptureInBackground(message.record, result);
      refreshRuntimeContextInBackground();
      return { ok: true, decisionLatencyMs: result.latencyMs, uiReadyAt: new Date().toISOString() };
    }));
  }
  if (message.type === "STATUS") {
    return respond((async () => {
      const context = await getCachedRuntimeContext();
      const { identity, state, ruleSet, settings, ruleSetMeta } = context;
      const events = await recentEvents(identity);
      const notifications = await getDutyNotifications(identity);
      refreshRuntimeContextInBackground();
      return {
        ok: true,
        stats: scopedStats(state, events),
        pendingCount: state.outboxIds.length,
        serverOnline: state.serverOnline,
        primaryTabId: state.primaryTabId,
        deviceId: state.deviceId,
        platformSession: state.platformSession,
        keepalive: state.keepalive,
        ruleSet: {
          version: ruleSet.version,
          status: ruleSet.status,
          source: ruleSetMeta.source,
          contentHash: ruleSetMeta.contentHash || null,
          lastSuccessfulAt: ruleSetMeta.lastSuccessfulAt || null,
          lastError: ruleSetMeta.lastError || null,
        },
        settings,
        events,
        notifications,
        identity
      };
    })());
  }
  if (message.type === "FLUSH") return respond(flushPending().then(() => ({ ok: true })));
  if (message.type === "PLATFORM_SESSION_STATUS") {
    if (!isHnPlatformUrl(sender.tab?.url)) return respond(Promise.reject(new Error("仅接受真实省平台页面的登录状态")));
    return respond(updatePlatformSession(message.session || {}, sender.tab?.id).then((platformSession) => ({ ok: true, platformSession })));
  }
  if (message.type === "SETTINGS_UPDATE") {
    return respond((async () => {
      const identity = await requireAssistantPermission("system.configure");
      const previous = await getSettings();
      const next = {
        ...previous,
        ...message.settings,
        intercom: { ...previous.intercom, ...(message.settings.intercom || {}) },
        prewarningTest: { ...previous.prewarningTest, ...(message.settings.prewarningTest || {}) },
      };
      next.assistantBase = validateAssistantBase(next.assistantBase || DEFAULT_ASSISTANT_BASE);
      if (next.assistantBase !== previous.assistantBase && next.assistantBase.startsWith("https://")) {
        const origin = `${new URL(next.assistantBase).origin}/*`;
        const granted = await chrome.permissions.contains({ origins: [origin] }) || await chrome.permissions.request({ origins: [origin] });
        if (!granted) throw new Error("未授权访问新的助手服务器地址");
      }
      if (!["DRY_RUN", "SANDBOX", "LIVE"].includes(next.mode)) throw new Error("无效运行模式");
      next.vehicleAllowlist = [...new Set((next.vehicleAllowlist || []).map(String).map((item) => item.trim()).filter(Boolean))];
      if (next.vehicleAllowlist.length > MAX_ALLOWLIST_ITEMS || next.vehicleAllowlist.some((item) => item.length > 100)) throw new Error("车辆白名单最多1000项且单项不超过100字符");
      next.popupSelectors = [...new Set((next.popupSelectors || []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
      if (next.popupSelectors.some((selector) => ["*", "html", "body"].includes(selector.toLowerCase()) || selector.length > 300)) throw new Error("弹窗选择器过宽或过长");
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      await audit("SETTINGS_UPDATED", { actorUserId: identity.userId, actorRoles: identity.roles, mode: next.mode, allowlistCount: next.vehicleAllowlist.length, intercomVerified: next.intercom.verified });
      return { ok: true, settings: next };
    })());
  }
  if (message.type === "ARM_SPEEDING_PREWARNING_TEST") {
    return respond(withProcessing(() => armAndExecuteSpeedingPrewarningTest(
      message.eventId,
      sender.tab?.id,
      message.confirmed,
    )));
  }
  if (message.type === "NOTE_ADD") {
    return respond((async () => {
      const identity = await requireAssistantPermission("disposal.note", { requireShift: true });
      const key = `event:${message.eventId}`;
      const stored = await chrome.storage.local.get(key);
      if (!stored[key]) throw new Error("报警事件不存在");
      requireEventEnterpriseAccess(identity, stored[key]);
      const noteText = String(message.text || "").trim();
      if (!noteText || noteText.length > 300) throw new Error("值班备注必须为1至300个字符");
      const event = { ...stored[key], notes: [...(stored[key].notes || []), { text: noteText, createdAt: new Date().toISOString(), actorUserId: identity.userId, actorDisplayName: identity.displayName }], updatedAt: new Date().toISOString() };
      await saveEvent(event);
      const disposalStored = await chrome.storage.local.get(`disposal:${message.eventId}`);
      const disposal = disposalStored[`disposal:${message.eventId}`];
      if (disposal?.caseId) {
        try {
          const updated = await assistantMutation(`/disposals/api/cases/${disposal.caseId}/notes`, { expectedVersion: disposal.version, comment: noteText }, identity);
          await chrome.storage.local.set({ [`disposal:${message.eventId}`]: updated.data });
        } catch (error) {
          await chrome.storage.local.set({ [`disposal-error:${message.eventId}`]: String(error?.message || error) });
        }
      }
      const linked = await chrome.storage.local.get([`decision:${message.eventId}`, `action:${message.eventId}`]);
      await persistLedger(event, linked[`decision:${message.eventId}`], linked[`action:${message.eventId}`]);
      return { ok: true };
    })());
  }
  if (message.type === "DOM_OBSERVATION") {
    return respond(audit("DOM_POPUP_OBSERVED", {
      selector: String(message.observation?.selector || ""),
      title: String(message.observation?.title || "").slice(0, 120),
      text: String(message.observation?.text || "").slice(0, 2000),
      pageUrl: sender.tab?.url || null,
      observedAt: message.observation?.observedAt || new Date().toISOString()
    }).then(() => ({ ok: true })));
  }
  if (message.type === "RETRY_ACTION") {
    return respond(withProcessing(async () => {
      const identity = await requireAssistantPermission("action.retry", { requireShift: true });
      const stored = await chrome.storage.local.get([`event:${message.eventId}`, `decision:${message.eventId}`, `action:${message.eventId}`]);
      const event = stored[`event:${message.eventId}`];
      const decision = stored[`decision:${message.eventId}`];
      if (!event || !decision || decision.action !== "AUTO_VOICE") throw new Error("该事件没有可重试的自动语音计划");
      requireEventEnterpriseAccess(identity, event);
      const previous = stored[`action:${message.eventId}`];
      if (previous && !["FAILED", "UNKNOWN", "BLOCKED"].includes(previous.status)) throw new Error("当前动作状态不允许重试");
      const [settings, assets] = await Promise.all([getSettings(), getAudioAssets()]);
      let action = createActionAttempt(event, decision, settings, assets[decision.audioAssetId]);
      action = { ...action, actionId: `action:${crypto.randomUUID()}`, retryOf: previous?.actionId || null, initiatedBy: "DUTY_OPERATOR", initiatedByUserId: identity.userId, initiatedByDisplayName: identity.displayName };
      await chrome.storage.local.set({ [`action:${event.eventId}`]: action });
      await persist("action", action);
      if (action.status !== "PLANNED") {
        await persistLedger(event, decision, action);
        return { ok: false, error: action.blockers.join("；") };
      }
      const result = await executeAction(event, decision, action, sender.tab?.id);
      return { ok: result.status === "SUCCEEDED", action: result, error: result.error || result.blockers?.join("；") || null };
    }));
  }
  if (message.type === "DISPOSAL_MUTATE") {
    return respond(withProcessing(async () => {
      const operations = {
        takeover: { permission: "disposal.takeover", path: "takeover" },
        complete: { permission: "disposal.complete", path: "complete" },
        review: { permission: "disposal.review", path: "review" },
        reopen: { permission: "disposal.reopen", path: "reopen" }
      };
      const operation = operations[message.operation];
      if (!operation) throw new Error("无效处置操作");
      const identity = await requireAssistantPermission(operation.permission, { requireShift: true });
      const stored = await chrome.storage.local.get([`event:${message.eventId}`, `disposal:${message.eventId}`]);
      const event = stored[`event:${message.eventId}`];
      const disposal = stored[`disposal:${message.eventId}`];
      if (!event || !disposal?.caseId) throw new Error("处置工单尚未同步");
      requireEventEnterpriseAccess(identity, event);
      const updated = await assistantMutation(`/disposals/api/cases/${disposal.caseId}/${operation.path}`, { expectedVersion: disposal.version, ...(message.payload || {}) }, identity);
      await chrome.storage.local.set({ [`disposal:${message.eventId}`]: updated.data });
      await chrome.storage.local.remove(`disposal-error:${message.eventId}`);
      return { ok: true, disposal: updated.data };
    }));
  }
  if (message.type === "EXPORT") return respond(Promise.reject(new Error("数据导出已迁移到独立报表中心，值班插件不再提供导出")));
  return false;
});

void initialize();
