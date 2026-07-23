(() => {
  const debugStore = HnCollectorDebug.createStore(20);
  const ALLOWED_RULES = new Set([
    "alarm-types", "realtime-alarms", "pending-alarms", "prewarning-alarms", "prewarning-query", "preprocessing-count", "alarm-query", "alarm-center-discovery", "alarm-count", "alarm-details",
    "technical-alarms", "vehicle-tree", "vehicle-info", "vehicle-types", "check-post",
    "report-alarm-disposal-discovery", "report-alarm-processing-discovery", "report-alarm-center-discovery",
    "report-vehicle-base-discovery", "report-track-completeness-discovery"
  ]);
  const alarmViewHelpers = globalThis.HnAlarmView;
  const platformIdentityHelpers = globalThis.HnPlatformIdentity;
  let dashboard = null;
  let selectedEventId = null;
  let popupObserver = null;
  let popupScanTimer = null;
  let settingsDirty = false;
  let alarmView = "priority";
  let lastPlatformSessionSignature = null;
  let lastPlatformContextSignature = null;
  let lastPlatformContext = null;
  let lastRealtimePollAt = null;
  let lastRealtimePollStatus = null;
  let lastRealtimeDomSignature = null;
  let extensionContextInvalidated = false;
  const observedPopups = new WeakSet();

  function runtimeErrorMessage(error) {
    return String(error?.message || error || "扩展后台通信失败").slice(0, 300);
  }

  function isExtensionContextError(error) {
    return /extension context invalidated|context invalidated|receiving end does not exist|could not establish connection/i.test(runtimeErrorMessage(error));
  }

  // chrome.runtime.sendMessage can throw synchronously when this page still
  // contains a content script from an extension version that was reloaded or
  // removed. A Promise.catch() alone cannot catch that synchronous throw.
  // Normalize both failure modes so page events never create an uncaught error.
  function runtimeSendMessage(message) {
    const failed = (error) => {
      if (isExtensionContextError(error)) extensionContextInvalidated = true;
      return { ok: false, error: runtimeErrorMessage(error), extensionContextInvalidated };
    };
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).then((response) => {
        extensionContextInvalidated = false;
        return response;
      }).catch(failed);
    } catch (error) {
      return Promise.resolve(failed(error));
    }
  }

  function platformDisplayName() {
    return platformIdentityHelpers?.readDisplayName(document) || "";
  }

  function platformPermissionSummary(route) {
    const buttons = [...document.querySelectorAll("button")].map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim());
    const links = [...document.querySelectorAll("a,[role='menuitem'],[role='button']")].map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim());
    const all = [...buttons, ...links].filter(Boolean).join(" ");
    const scopeNodes = [...document.querySelectorAll(
      "select option,[role='option'],.el-tree-node__label,.ant-select-selection-item,[class*='enterprise-name'],[class*='group-name']"
    )];
    const scopeTokens = [...new Set(scopeNodes.map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim()).filter((text) => text && text.length <= 200))].sort();
    return {
      routeRealTime: /^#\/vehicle-monitor\/real-time(?:$|[/?])/i.test(route),
      routePreprocessing: /^#\/alarm-center\/alarm-preprocessing(?:$|[/?])/i.test(route),
      routePrewarning: /^#\/alarm-center\/pr-alarm-recorde(?:$|[/?])/i.test(route),
      hasQueryButton: buttons.filter((text) => text === "查询").length === 1,
      hasAlarmNavigation: /报警/.test(all),
      hasTechnicalNavigation: /技术检测|技术报警/.test(all),
      visibleScopeSelector: scopeTokens.length > 0,
      visibleScopeCount: scopeTokens.length
    };
  }

  async function sha256Hex(value) {
    try {
      if (!globalThis.crypto?.subtle) return "";
      const bytes = new TextEncoder().encode(value);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
    } catch {
      return "";
    }
  }

  async function platformContext(status, route) {
    if (status !== "AUTHENTICATED") return {
      platformDisplayName: "", platformIdentityStatus: "UNKNOWN", platformVisibleScopeHash: "",
      platformPermissionSummary: {}, platformIdentityObservedAt: null
    };
    const displayName = platformDisplayName();
    const permissionSummary = platformPermissionSummary(route);
    const scopeNodes = [...document.querySelectorAll(
      "select option,[role='option'],.el-tree-node__label,.ant-select-selection-item,[class*='enterprise-name'],[class*='group-name']"
    )];
    const scopeTokens = [...new Set(scopeNodes.map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim()).filter((text) => text && text.length <= 200))].sort();
    const signature = `${displayName}|${JSON.stringify(permissionSummary)}|${scopeTokens.join("\n")}`;
    if (signature === lastPlatformContextSignature && lastPlatformContext) return lastPlatformContext;
    const context = {
      platformDisplayName: displayName,
      // A visible name is an observation, not a formal platform identity proof.
      platformIdentityStatus: displayName ? "UNVERIFIED" : "UNKNOWN",
      platformVisibleScopeHash: scopeTokens.length ? await sha256Hex(scopeTokens.join("\n")) : "",
      platformPermissionSummary: permissionSummary,
      platformIdentityObservedAt: new Date().toISOString()
    };
    lastPlatformContextSignature = signature;
    lastPlatformContext = context;
    return context;
  }

  function detectPlatformSession() {
    if (!(location.hostname === "hnznjg.cn" || location.hostname.endsWith(".hnznjg.cn"))) return null;
    const route = location.hash || "";
    const loginRoute = /^#\/login(?:$|[/?])/i.test(route);
    const loginSignals = [
      'input[placeholder*="手机号码"]',
      'input[placeholder*="密码"]',
      'input[placeholder*="图形验证码"]',
      'input[placeholder*="手机验证码"]'
    ].filter((selector) => document.querySelector(selector)).length;
    const loginForm = loginSignals >= 2;
    if (loginRoute || loginForm) return { status: "LOGIN_REQUIRED", route, reason: "省平台显示登录页面" };
    if (route && route !== "#/") return { status: "AUTHENTICATED", route, reason: "省平台业务页面可见" };
    return { status: "UNKNOWN", route, reason: "暂时无法确认省平台登录状态" };
  }

  async function reportPlatformSession() {
    const session = detectPlatformSession();
    if (!session) return;
    const context = await platformContext(session.status, session.route);
    const signature = `${session.status}|${session.route}|${context.platformDisplayName}|${context.platformVisibleScopeHash}|${JSON.stringify(context.platformPermissionSummary)}`;
    if (signature === lastPlatformSessionSignature) return;
    lastPlatformSessionSignature = signature;
    void runtimeSendMessage({ type: "PLATFORM_SESSION_STATUS", session: { ...session, ...context } });
  }

  function validRecord(record) {
    if (!record || !ALLOWED_RULES.has(record.matchedRule)) return false;
    try {
      const hostname = new URL(record.url).hostname;
      return hostname.endsWith(".hnznjg.cn") || hostname === "127.0.0.1" || hostname === "localhost";
    } catch { return false; }
  }

  async function backfillVisibleRealtimeAlarms() {
    if (!/^#\/vehicle-monitor\/real-time(?:$|[/?])/i.test(location.hash || "")) return;
    const panel = document.querySelector(".base-panel.real-time-footer");
    const activeTab = panel?.querySelector(".tab-item.active");
    if (!/^实时报警(?:\s*\d+)?$/.test(String(activeTab?.textContent || "").replace(/\s+/g, " ").trim())) return;
    const tables = [...panel.querySelectorAll("table")];
    const table = tables.find((candidate) => {
      const headers = [...candidate.querySelectorAll("thead th")].map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim());
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && HnRealtimeDom.REQUIRED_HEADERS.every((header) => headers.includes(header));
    });
    if (!table) return;
    const headers = [...table.querySelectorAll("thead th")].map((node) => node.textContent || "");
    const tableRows = [...table.querySelectorAll("tbody tr")].slice(0, 500).map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent || ""));
    const extracted = HnRealtimeDom.extractRows(headers, tableRows);
    if (!extracted.ok || extracted.signature === lastRealtimeDomSignature) return;
    if (!extracted.rows.length) return;
    const capturedAt = new Date().toISOString();
    const response = await runtimeSendMessage({
      type: "CAPTURE",
      receivedAt: capturedAt,
      record: {
        captureId: `dom-realtime:${extracted.signature}`,
        capturedAt,
        matchedRule: "realtime-alarms",
        category: "alarm",
        isAlarm: true,
        method: "DOM",
        status: 200,
        route: location.hash.split("?")[0],
        url: `${location.origin}${location.pathname}${location.hash.split("?")[0]}`,
        response: { body: { data: extracted.rows } },
      },
    });
    if (response?.ok) lastRealtimeDomSignature = extracted.signature;
  }

  const REPORT_NAVIGATION = Object.freeze({
    ALARM_DISPOSAL_RATE: { parent: "报表中心", leaf: "处置率报表", route: "#/report-center/alarm-disposal-rate" },
    ALARM_PROCESSING_RATE: { parent: "报表中心", leaf: "处理率报表", route: "#/report-center/alarm-process-rate" },
    ALARM_CENTER: { parent: "报表中心", leaf: "报警信息查询", route: "#/report-center/alarm-info" },
    VEHICLE_BASE_INFO: { parent: "报表中心", leaf: "车辆基础信息", route: "#/report-center/vehicle-mes" },
    TRACK_COMPLETENESS: { parent: "联网联控", leaf: "考核明细", route: "#/network-monitor/examine-list", tab: "轨迹完整率明细" },
  });
  const REPORT_FETCH_ALLOWLIST = Object.freeze({
    ALARM_DISPOSAL_RATE: { route: "#/report-center/alarm-disposal-rate", path: "/api/report-service/alarm/info/alarmResponseRateCount" },
    ALARM_PROCESSING_RATE: { route: "#/report-center/alarm-process-rate", path: "/api/report-service/alarm/info/alarmProcessingRateCount" },
    ALARM_CENTER: { route: "#/report-center/alarm-info", path: "/api/report-service/alarm/info/alarmInformationQueryReport" },
    VEHICLE_BASE_INFO: { route: "#/report-center/vehicle-mes", path: "/api/report-service/alarmDriverFaceResult/queryVehicleList" },
    TRACK_COMPLETENESS: { route: "#/network-monitor/examine-list", path: "/api/report-service/network/kpi/mile" },
  });
  const REPORT_REQUEST_FIELDS = Object.freeze({
    ALARM_DISPOSAL_RATE: ["alarmIds", "alarmQueryEndTime", "alarmQueryStartTime", "certId", "groupIdList", "latitudeSelection", "pageNum", "pageSize", "searchFlag", "timeType", "vehicleStatus"],
    ALARM_PROCESSING_RATE: ["alarmIds", "alarmQueryEndTime", "alarmQueryStartTime", "certId", "groupIdList", "latitudeSelection", "pageNum", "pageSize", "searchFlag", "timeType", "vehicleStatus"],
    ALARM_CENTER: ["alarmIds", "alarmQueryEndTime", "alarmQueryStartTime", "certId", "dispositionMode", "driverName", "groupIdList", "latitudeSelection", "manufactorId", "pageNum", "pageSize", "searchFlag", "timeType", "vehicleStatus"],
    VEHICLE_BASE_INFO: ["certId", "groupId", "manufactorName", "pageNum", "pageSize", "vehicleStatus"],
    TRACK_COMPLETENESS: ["areaCode", "carId", "companyId", "endTime", "kpiType", "linType", "pageNum", "pageSize", "startTime", "tt", "vehicleStatus"],
  });
  let activeReportContext = null;
  let activeAlarmDictionaryIds = [];

  function validReportRequest(sourceType, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const expected = REPORT_REQUEST_FIELDS[sourceType];
    if (!expected || !activeReportContext || activeReportContext.sourceType !== sourceType || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected)) return false;
    if (!Number.isInteger(body.pageNum) || body.pageNum < 1 || body.pageNum > 400 || body.pageSize !== 500) return false;
    const statuses = [...new Set((body.vehicleStatus || []).map(String))].sort();
    if (JSON.stringify(statuses) !== JSON.stringify(activeReportContext.vehicleStatusCodes)) return false;
    if (sourceType.startsWith("ALARM_")) {
      return body.searchFlag === "1" && body.latitudeSelection === "5" && body.timeType === "2"
        && Array.isArray(body.groupIdList) && body.groupIdList.length === 0
        && body.certId === "" && (body.driverName === undefined || body.driverName === "")
        && (body.dispositionMode === undefined || body.dispositionMode === "")
        && (body.manufactorId === undefined || body.manufactorId === "")
        && JSON.stringify([...new Set((body.alarmIds || []).map(String))].sort()) === JSON.stringify(activeAlarmDictionaryIds)
        && body.alarmQueryStartTime === `${activeReportContext.periodStart} 00:00:00`
        && body.alarmQueryEndTime === `${activeReportContext.periodEnd} 23:59:59`;
    }
    if (sourceType === "VEHICLE_BASE_INFO") return Array.isArray(body.groupId) && body.groupId.length === 0 && body.certId === "" && body.manufactorName === "";
    return body.kpiType === 4 && JSON.stringify(body.linType) === "[1,2,3,4]"
      && body.tt === "" && body.areaCode === "" && body.companyId === "" && body.carId === ""
      && body.startTime === activeReportContext.periodStart && body.endTime === activeReportContext.periodEnd;
  }

  function freezeReportContext(sourceType, context) {
    const statuses = [...new Set((context?.vehicleStatusCodes || []).map(String))].sort();
    const periodStart = String(context?.periodStart || "");
    const periodEnd = String(context?.periodEnd || "");
    if (statuses.length < 2 || !statuses.includes("10") || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return false;
    activeReportContext = Object.freeze({ sourceType, vehicleStatusCodes: statuses, periodStart, periodEnd });
    return true;
  }

  function exactVisibleText(text, selectors) {
    return exactVisibleTextWithin(document, text, selectors);
  }

  function exactVisibleTextWithin(root, text, selectors) {
    const nodes = [...root.querySelectorAll(selectors)];
    return nodes.filter((node) => {
      const value = String(node.textContent || "").replace(/\s+/g, " ").trim();
      let current = node;
      while (current && current !== document.documentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
        current = current.parentElement;
      }
      return value === text;
    });
  }

  async function waitForReportState(predicate, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async function navigateReportSource(sourceType) {
    const target = REPORT_NAVIGATION[sourceType];
    if (!target) return { ok: false, code: "REPORT_SOURCE_UNKNOWN" };
    if ((location.hash || "").split("?")[0] !== target.route) {
      const leafBefore = exactVisibleText(target.leaf, "li.el-menu-item,li[role='menuitem']");
      if (leafBefore.length !== 1) {
        const parents = exactVisibleText(target.parent, ".el-submenu__title,li[role='menuitem']");
        if (parents.length !== 1) return { ok: false, code: parents.length ? "REPORT_PARENT_AMBIGUOUS" : "REPORT_PARENT_NOT_FOUND" };
        parents[0].click();
        await waitForReportState(() => exactVisibleText(target.leaf, "li.el-menu-item,li[role='menuitem']").length === 1, 3000);
      }
      const leaves = exactVisibleText(target.leaf, "li.el-menu-item,li[role='menuitem']");
      if (leaves.length !== 1) return { ok: false, code: leaves.length ? "REPORT_LEAF_AMBIGUOUS" : "REPORT_LEAF_NOT_FOUND" };
      leaves[0].click();
      const arrived = await waitForReportState(() => (location.hash || "").split("?")[0] === target.route);
      if (!arrived) return { ok: false, code: "REPORT_ROUTE_TIMEOUT", route: (location.hash || "").split("?")[0] };
    }
    if (target.tab) {
      const tabs = exactVisibleText(target.tab, ".el-radio-group .el-radio-button");
      if (tabs.length !== 1) return { ok: false, code: tabs.length ? "REPORT_SOURCE_TAB_AMBIGUOUS" : "REPORT_SOURCE_TAB_NOT_FOUND", route: target.route };
      const clickable = tabs[0];
      if (!clickable.classList?.contains("is-active")) clickable.click();
      const active = await waitForReportState(() => exactVisibleText(target.tab, ".el-radio-group .el-radio-button.is-active").length === 1, 3000);
      if (!active) return { ok: false, code: "REPORT_SOURCE_TAB_TIMEOUT", route: target.route };
    }
    return { ok: true, code: "REPORT_SOURCE_READY", sourceType, route: target.route };
  }

  async function navigateRealtimeMonitor() {
    const route = "#/vehicle-monitor/real-time";
    if ((location.hash || "").split("?")[0] === route) return { ok: true, code: "REALTIME_MONITOR_READY", route };
    const parentText = "值班值守监控";
    const leafText = "实时监控";
    const parents = exactVisibleText(parentText, ".el-submenu__title");
    if (parents.length !== 1) return { ok: false, code: parents.length ? "REALTIME_PARENT_AMBIGUOUS" : "REALTIME_PARENT_NOT_FOUND" };
    const submenu = parents[0].closest(".el-submenu");
    if (!submenu) return { ok: false, code: "REALTIME_PARENT_CONTAINER_NOT_FOUND" };
    let leaves = exactVisibleTextWithin(submenu, leafText, "li.el-menu-item,li[role='menuitem']");
    if (leaves.length !== 1) {
      parents[0].click();
      await waitForReportState(() => exactVisibleTextWithin(submenu, leafText, "li.el-menu-item,li[role='menuitem']").length === 1, 3000);
      leaves = exactVisibleTextWithin(submenu, leafText, "li.el-menu-item,li[role='menuitem']");
    }
    if (leaves.length !== 1) return { ok: false, code: leaves.length ? "REALTIME_LEAF_AMBIGUOUS" : "REALTIME_LEAF_NOT_FOUND" };
    leaves[0].click();
    const arrived = await waitForReportState(() => (location.hash || "").split("?")[0] === route);
    return arrived
      ? { ok: true, code: "REALTIME_MONITOR_READY", route }
      : { ok: false, code: "REALTIME_ROUTE_TIMEOUT", route: (location.hash || "").split("?")[0] };
  }

  async function fetchPlatformReportPage(request) {
    const allowed = REPORT_FETCH_ALLOWLIST[request?.sourceType];
    if (!allowed) return { ok: false, code: "REPORT_SOURCE_UNKNOWN" };
    if ((location.hash || "").split("?")[0] !== allowed.route) return { ok: false, code: "REPORT_ROUTE_MISMATCH" };
    const authorization = String(request?.authorization || "").trim();
    if (!/^Bearer \S{8,4080}$/.test(authorization)) return { ok: false, code: "PLATFORM_TOKEN_MISSING" };
    if (!validReportRequest(request.sourceType, request.body)) return { ok: false, code: "REPORT_REQUEST_INVALID" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(allowed.path, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json", authorization },
        body: JSON.stringify(request.body), signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!payload) return { ok: false, code: "PLATFORM_RESPONSE_UNKNOWN", platformHttpStatus: response.status };
      if (!response.ok || payload.success === false) return { ok: false, code: "PLATFORM_REPORT_FAILED", platformHttpStatus: response.status };
      return { ok: true, payload, platformHttpStatus: response.status };
    } catch (error) {
      return { ok: false, code: error?.name === "AbortError" ? "PLATFORM_REPORT_TIMEOUT" : "PLATFORM_REPORT_REQUEST_FAILED" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchPlatformAlarmDictionary(authorization) {
    const token = String(authorization || "").trim();
    if (!/^Bearer \S{8,4080}$/.test(token)) return { ok: false, code: "PLATFORM_TOKEN_MISSING" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/alarm-service/alarmUserSet/listAll", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json", authorization: token },
        body: "{}", signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      const dictionaryIds = Array.isArray(payload?.data)
        ? payload.data.map((item) => String(item?.alarmId ?? "").trim()).filter(Boolean)
        : [];
      if (!dictionaryIds.length || new Set(dictionaryIds).size !== dictionaryIds.length
        || dictionaryIds.some((item) => item.length > 160 || !item)
        || payload.data.some((item) => !String(item?.alarmName ?? "").trim())) {
        return { ok: false, code: "ALARM_DICTIONARY_CONTRACT_MISMATCH" };
      }
      activeAlarmDictionaryIds = [...dictionaryIds].sort();
      return response.ok && payload && payload.success !== false
        ? { ok: true, payload }
        : { ok: false, code: "ALARM_DICTIONARY_FAILED", platformHttpStatus: response.status };
    } catch (error) {
      return { ok: false, code: error?.name === "AbortError" ? "ALARM_DICTIONARY_TIMEOUT" : "ALARM_DICTIONARY_FAILED" };
    } finally {
      clearTimeout(timeout);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source === window && event.origin === location.origin && event.data?.source === "hn-alarm-realtime-poll") {
      lastRealtimePollAt = event.data.polledAt || new Date().toISOString();
      lastRealtimePollStatus = Number(event.data.status || 0);
      return;
    }
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "hn-alarm-collector-page" || !validRecord(event.data.record)) return;
    debugStore.add(event.data.record);
    void runtimeSendMessage({ type: "CAPTURE", record: event.data.record, receivedAt: new Date().toISOString() }).then(refresh);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "AUTHORIZED_KEEPALIVE_EXECUTE") {
      try {
        sendResponse(HnAuthorizedKeepalive.execute({ document, location }));
      } catch {
        sendResponse({ ok: false, code: "TARGET_NOT_FOUND", route: location.hash || "", actionKey: "ALARM_PREPROCESSING_QUERY", latencyMs: 0 });
      }
      return false;
    }
    if (message?.type === "PLATFORM_ACTION_EXECUTE") {
      Promise.resolve(globalThis.HnPlatformActionRuntime?.execute(message.request))
        .then((result) => sendResponse(result || { status: "BLOCKED", errorCode: "ACTION_RUNTIME_UNAVAILABLE" }))
        .catch((error) => sendResponse(
          globalThis.HnPlatformActionRuntime?.safeRuntimeException?.(error)
            || { status: "UNKNOWN", errorCode: "ACTION_RUNTIME_EXCEPTION" }
        ));
      return true;
    }
    if (message?.type === "PLATFORM_ALARM_ROW_CHECK") {
      Promise.resolve(globalThis.HnPlatformActionRuntime?.checkAlarmRow(
        document,
        message.event,
        (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        3000
      ))
        .then((result) => sendResponse(result || { status: "BLOCKED", errorCode: "ACTION_RUNTIME_UNAVAILABLE" }))
        .catch(() => sendResponse({ status: "UNKNOWN", errorCode: "ALARM_ROW_CHECK_EXCEPTION" }));
      return true;
    }
    if (message?.type === "PLATFORM_REPORT_NAVIGATE") {
      navigateReportSource(message.sourceType)
        .then((result) => {
          if (result.ok && !freezeReportContext(message.sourceType, message.context)) return sendResponse({ ok: false, code: "REPORT_CONTEXT_INVALID" });
          sendResponse(result);
        })
        .catch(() => sendResponse({ ok: false, code: "REPORT_NAVIGATION_EXCEPTION" }));
      return true;
    }
    if (message?.type === "PLATFORM_REALTIME_NAVIGATE") {
      navigateRealtimeMonitor()
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, code: "REALTIME_NAVIGATION_EXCEPTION" }));
      return true;
    }
    if (message?.type === "PLATFORM_REPORT_FETCH_PAGE") {
      fetchPlatformReportPage(message.request)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, code: "REPORT_FETCH_EXCEPTION" }));
      return true;
    }
    if (message?.type === "PLATFORM_ALARM_DICTIONARY_FETCH") {
      fetchPlatformAlarmDictionary(message.authorization)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, code: "ALARM_DICTIONARY_FAILED" }));
      return true;
    }
    return false;
  });

  const host = document.createElement("div");
  host.id = "hn-alarm-assistant-panel";
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box}button,input,textarea,select{font:inherit}
      .shell{display:flex;flex-direction:column;width:420px;max-height:82vh;color:#eaf2f8;background:#102333;border:1px solid #36536a;border-radius:10px;box-shadow:0 18px 48px #001a;overflow:hidden;font:13px/1.45 "Microsoft YaHei",sans-serif}
      .top{display:flex;flex:none;align-items:center;justify-content:space-between;padding:13px 14px;background:#0b1b27;border-bottom:1px solid #ffffff16}.brand{font-weight:800;letter-spacing:.02em}.dot{display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:#46d69a;box-shadow:0 0 0 4px #46d69a20}
      button{border:1px solid #ffffff18;border-radius:6px;color:#dbeaf5;background:#224159;cursor:pointer}button:hover{background:#2d526d}button:disabled{opacity:.45;cursor:not-allowed}.collapse{width:28px;height:26px}.body{padding:12px}.hidden{display:none!important}
      .body{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:12px}.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:11px}.tab{padding:7px 3px;background:#172f43}.tab.active{color:#fff;background:#2670a5;border-color:#4791c5}
      .notice{padding:9px 10px;margin-bottom:10px;border-left:3px solid #f0b35b;background:#f0b35b16;color:#ffdca8}.notice.ok{border-color:#43d49a;background:#43d49a12;color:#b8f5db}.notice.bad{border-color:#f17068;background:#f1706813;color:#ffc6c2}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.metric{padding:9px;background:#152d40;border:1px solid #ffffff10;border-radius:7px}.metric span{display:block;color:#8eacbf;font-size:11px}.metric strong{display:block;margin-top:3px;color:#fff;font-size:16px}.metric .small{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .toolbar{display:flex;gap:7px;margin-top:10px}.toolbar button{flex:1;padding:8px}.primary{background:#1677b8}.danger{background:#8c3535}.warn{background:#7f5a24}
      .source-tabs{display:flex;gap:5px;overflow-x:auto;margin-bottom:9px}.source-tab{flex:none;padding:6px 8px;font-size:11px}.source-tab.active{background:#2670a5;border-color:#4791c5}.source-label{color:#79c9ff}
      .list{display:grid;gap:7px;max-height:48vh;overflow:auto;padding-right:2px}.card{padding:10px;text-align:left;background:#152e42;border:1px solid #ffffff12;border-radius:7px}.card:hover{border-color:#5c89a7}.row{display:flex;align-items:center;justify-content:space-between;gap:8px}.title{font-weight:700;color:#fff}.muted{color:#89a7ba;font-size:11px}.badge{padding:2px 6px;border-radius:999px;background:#24506c;color:#cfefff;font-size:10px;white-space:nowrap}.badge.manual{background:#7a5627;color:#ffe1ad}.badge.success{background:#216044;color:#bbf5d8}.badge.fail{background:#753837;color:#ffd0cb}
      .empty{padding:22px;text-align:center;color:#7e9bad}.form{display:grid;gap:9px}.form label{display:grid;gap:4px;color:#a9c1d1}.form input,.form textarea,.form select{width:100%;padding:8px;color:#eff8ff;background:#0b1f2d;border:1px solid #36566d;border-radius:6px}.form textarea{min-height:66px;resize:vertical}.form small{color:#7694a8}.check{display:flex!important;grid-template-columns:none!important;align-items:center;gap:7px}.check input{width:auto}
      .detail{max-height:55vh;overflow:auto}.kv{display:grid;grid-template-columns:108px 1fr;gap:5px 9px;padding:9px 0;border-bottom:1px solid #ffffff12}.kv span{color:#86a5b9}.kv strong{color:#edf7fd;word-break:break-word}.back{padding:5px 9px;margin-bottom:9px}.note-row{display:flex;gap:6px;margin-top:9px}.note-row input{flex:1;padding:8px;color:#fff;background:#0b1f2d;border:1px solid #36566d;border-radius:6px}.note-row button{padding:0 12px}
      .technical-summary{margin-top:4px;color:#b8d7e9;word-break:break-word}.technical-block{margin-top:10px;padding:9px 10px;border-left:3px solid #63b4e8;background:#63b4e812}.technical-block strong{display:block;margin-bottom:4px;color:#dff3ff}.technical-block .kv{grid-template-columns:108px 1fr;padding:6px 0}
      .foot{flex:none;padding:8px 12px;color:#6f8ea2;background:#0b1b27;border-top:1px solid #ffffff12;font-size:10px}
    </style>
    <section class="shell">
      <header class="top"><div class="brand"><span class="dot"></span>三客一危值班助手</div><button class="collapse" title="收起">−</button></header>
      <div class="body">
        <nav class="tabs"><button class="tab active" data-view="overview">状态</button><button class="tab" data-view="events">报警</button><button class="tab" data-view="captures">抓取</button><button class="tab" data-view="settings">设置</button></nav>
        <main class="view overview"></main>
        <main class="view events hidden"></main>
        <main class="view captures hidden"></main>
        <main class="view settings hidden"></main>
        <main class="view event-detail hidden"></main>
      </div>
      <footer class="foot">真实自动运行 · 异常立即停止并转人工</footer>
    </section>`;

  function mount() {
    if (!document.documentElement.contains(host)) document.documentElement.appendChild(host);
  }
  if (document.documentElement) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });

  const shell = shadow.querySelector(".shell");
  shadow.querySelector(".collapse").addEventListener("click", (event) => {
    const body = shadow.querySelector(".body");
    const foot = shadow.querySelector(".foot");
    body.classList.toggle("hidden"); foot.classList.toggle("hidden");
    event.currentTarget.textContent = body.classList.contains("hidden") ? "+" : "−";
  });
  shadow.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));

  function showView(name) {
    shadow.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
    shadow.querySelector(`.${name}`).classList.remove("hidden");
    shadow.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
    if (name === "settings") renderSettings();
  }

  function actionBadge(item) {
    const value = item.action?.status || item.decision?.action || "待判断";
    const cls = value === "SUCCEEDED" ? "success" : ["FAILED", "UNKNOWN", "BLOCKED"].includes(value) ? "fail" : value === "MANUAL_REVIEW" ? "manual" : "";
    return `<span class="badge ${cls}">${escapeHtml(value)}</span>`;
  }

  function completionBadge(item) {
    const assessment = item.event?.completionAssessment || item.decision?.completionAssessment || {};
    const labels = {
      PLATFORM_CLEARED: "平台已解除",
      PLATFORM_ACTIVE: "平台仍持续",
      UNKNOWN_MANUAL: "无法判断·转人工",
    };
    const cls = assessment.status === "PLATFORM_CLEARED" ? "success" : assessment.status === "UNKNOWN_MANUAL" ? "manual" : "fail";
    return `<span class="badge ${cls}">${escapeHtml(labels[assessment.status] || assessment.status || "待确认")}</span>`;
  }

  function reminderBadge(item) {
    const mode = item.decision?.reminderPolicy?.driverReminder;
    const labels = { VOICE_REQUIRED: "语音必做", VOICE_PREFERRED: "语音优先", TEXT_ONLY: "文本/TTS", INTERNAL_ONLY: "内部确认", VOICE_OR_TEXT_PENDING: "提醒待确认" };
    return mode ? `<span class="badge">${escapeHtml(labels[mode] || mode)}</span>` : "";
  }

  function hasPermission(permission) {
    return Boolean(dashboard?.identity?.authenticated && dashboard.identity.permissions?.includes(permission));
  }

  function hasActiveShift() {
    return Boolean(dashboard?.identity?.activeShift);
  }

  function renderOverview() {
    if (!dashboard) return;
    const s = dashboard.stats;
    const identity = dashboard.identity || {};
    const identityName = identity.authenticated ? identity.displayName : "未登录";
    const identityRoles = identity.authenticated ? (identity.roles || []).join(" / ") || "未分配角色" : identity.code || "身份服务不可用";
    const shiftLabel = identity.activeShift ? `${identity.activeShift.workstationId} · 已认领` : "未认领";
    const mode = "真实自动运行";
    const platformSession = dashboard.platformSession || {};
    const pendingSources = (platformSession.recoveryPendingSources || []).map((source) => ({ "realtime-alarms": "实时报警", "technical-alarms": "技术检测" })[source] || source);
    const platformLabel = platformSession.status === "AUTHENTICATED" ? (platformSession.recoveryRequired ? "已登录·待补采" : "已登录") : platformSession.status === "LOGIN_REQUIRED" ? "需要重新登录" : "状态待确认";
    const platformNotice = platformSession.status === "LOGIN_REQUIRED"
      ? `<div class="notice bad">省平台已退出登录。授权会话保活和真实动作均已暂停，报警数据与处理进度会保留。请人工重新登录；系统不会自动填写账号、验证码或处理人机挑战。</div>`
      : platformSession.status === "AUTHENTICATED" && platformSession.recoveryRequired
        ? `<div class="notice">登录已经恢复，请优先刷新实时报警和技术检测完成断点补采。待补采：${escapeHtml(pendingSources.join("、") || "无")}。</div>`
        : `<div class="notice ok">省平台登录状态正常。系统仅在报警预处理页按管理员策略低频点击唯一“查询”按钮；其他页面会跳过且不会抢占人工操作。</div>`;
    const keepalive = dashboard.keepalive || {};
    const notifications = Array.isArray(dashboard.notifications) ? dashboard.notifications : [];
    const keepalivePolicy = keepalive.policy || {};
    const keepaliveLabel = keepalivePolicy.enabled ? `已启用 · ${keepalivePolicy.intervalMinutes}分钟` : "未启用";
    const warning = `<div class="notice bad">当前只运行真实场景。符合已发布规则的新报警会自动取得全局租约并执行；权限、凭证、字段或回执不完整时立即停止并转人工。</div>`;
    const notificationNotice = notifications.length
      ? `<div class="notice bad">有 ${notifications.length} 条动作需要人工处理：${escapeHtml(notifications.slice(0, 3).map((item) => item.message).join("；"))}</div>`
      : "";
    shadow.querySelector(".overview").innerHTML = `${platformNotice}${warning}${notificationNotice}<div class="grid">
      ${metric("本机服务", dashboard.serverOnline ? "已连接" : "未连接")}${metric("运行模式", mode)}
      ${metric("省平台会话", platformLabel, true)}${metric("断点补采", pendingSources.length ? pendingSources.join("、") : "无需补采", true)}
      ${metric("授权会话保活", keepaliveLabel, true)}${metric("最近保活结果", keepalive.lastResultCode || "尚未执行", true)}
      ${metric("上次保活成功", keepalive.lastSuccessAt || "尚无", true)}${metric("下次计划", keepalive.nextScheduledAt || "等待策略", true)}
      ${metric("标准报警", s.events)}${metric("待同步", dashboard.pendingCount)}
      ${metric("自动响应计划", s.autoVoice)}${metric("待人工", s.manual)}
      ${metric("仅记录", s.recordOnly)}${metric("动作异常", s.failedActions)}
      ${metric("未读通知", notifications.length)}
      ${metric("最近决策耗时", s.lastDecisionLatencyMs == null ? "尚无" : `${s.lastDecisionLatencyMs}ms`, true)}${metric("最大决策耗时", s.maxDecisionLatencyMs == null ? "尚无" : `${s.maxDecisionLatencyMs}ms`, true)}
      ${metric("后台待处理", s.backgroundPending || 0)}${metric("后台失败", s.backgroundFailed || 0)}
      ${metric("实名用户", identityName, true)}${metric("当前角色", identityRoles, true)}
      ${metric("当前班次", shiftLabel, true)}${metric("企业范围", identity.enterpriseScopes?.length || 0)}
      ${metric("规则版本", dashboard.ruleSet.version, true)}${metric("最近接口", s.lastRule || "等待中", true)}
    </div><div class="toolbar"><button class="primary go-events">查看报警</button><button class="retry">重试落盘</button>${identity.authenticated ? "" : `<button class="login-assistant">实名登录</button>`}</div>`;
    shadow.querySelector(".go-events").addEventListener("click", () => showView("events"));
    shadow.querySelector(".retry").addEventListener("click", () => void runtimeSendMessage({ type: "FLUSH" }).then(refresh));
    shadow.querySelector(".login-assistant")?.addEventListener("click", () => window.open("http://127.0.0.1:18080/assistant/login", "_blank", "noopener"));
  }

  function metric(label, value, small = false) {
    return `<div class="metric"><span>${label}</span><strong class="${small ? "small" : ""}">${escapeHtml(value ?? 0)}</strong></div>`;
  }

  function renderEvents() {
    const target = shadow.querySelector(".events");
    const items = dashboard?.events || [];
    const counts = alarmViewHelpers.countsFor(items);
    const latestPrewarningCapture = items.filter((item) => item.event.sourceKind === "PREWARNING")
      .map((item) => Date.parse(item.event.updatedAt || item.event.discoveredAt || ""))
      .filter(Number.isFinite).sort((a, b) => b - a)[0] || 0;
    const realtimePollAge = Date.parse(lastRealtimePollAt || "");
    const prewarningFreshness = Number.isFinite(realtimePollAge)
      ? `${Math.max(0, Math.floor((Date.now() - realtimePollAge) / 1000))}秒前轮询（HTTP ${lastRealtimePollStatus || "-"}）`
      : latestPrewarningCapture
      ? `${Math.max(0, Math.floor((Date.now() - latestPrewarningCapture) / 1000))}秒前更新`
      : "尚未在实时监控预警列表或预警查询页捕获";
    const visibleItems = alarmViewHelpers.filterEvents(items, alarmView);
    target.innerHTML = `<div class="source-tabs">
      <button class="source-tab ${alarmView === "priority" ? "active" : ""}" data-source="priority">优先队列 ${counts.FORMAL + counts.TECHNICAL}</button>
      <button class="source-tab ${alarmView === "FORMAL" ? "active" : ""}" data-source="FORMAL">正式报警 ${counts.FORMAL}</button>
      <button class="source-tab ${alarmView === "TECHNICAL" ? "active" : ""}" data-source="TECHNICAL">技术检测 ${counts.TECHNICAL}</button>
      <button class="source-tab ${alarmView === "PREWARNING" ? "active" : ""}" data-source="PREWARNING">预报警 ${counts.PREWARNING}</button>
      <button class="source-tab ${alarmView === "all" ? "active" : ""}" data-source="all">全部 ${items.length}</button>
    </div><div class="notice">预报警原始来源始终保留为 PREWARNING；新发生且字段完整的超速预警按真实自动规则处理，其他未发布规则只记录或转人工：${escapeHtml(prewarningFreshness)}。</div><div class="list">${visibleItems.length ? visibleItems.map((item) => {
      const event = item.event;
      const technicalSummary = event.sourceKind === "TECHNICAL" ? event.technicalDetails?.detail : null;
      return `<button class="card event-card" data-id="${escapeHtml(event.eventId)}"><div class="row"><span class="title">${escapeHtml(event.vehicleNo || "未知车辆")}</span><span>${actionBadge(item)} ${reminderBadge(item)} ${completionBadge(item)}</span></div><div>${escapeHtml(event.alarmName || "未知报警")}</div>${technicalSummary ? `<div class="technical-summary">${escapeHtml(technicalSummary)}</div>` : ""}<div class="muted"><span class="source-label">${escapeHtml(alarmViewHelpers.displaySourceLabel(event))}</span> · ${escapeHtml(event.alarmTime || event.discoveredAt || "-")} · ${escapeHtml(event.companyName || "企业待补")}</div></button>`;
    }).join("") : `<div class="empty">尚未形成标准报警事件</div>`}</div>`;
    target.querySelectorAll(".source-tab").forEach((button) => button.addEventListener("click", () => {
      alarmView = button.dataset.source;
      renderEvents();
    }));
    target.querySelectorAll(".event-card").forEach((button) => button.addEventListener("click", () => showEvent(button.dataset.id)));
  }

  function showEvent(eventId) {
    selectedEventId = eventId;
    const item = dashboard.events.find((entry) => entry.event.eventId === eventId);
    if (!item) return;
    const event = item.event;
    const disposal = item.disposal;
    const visibleConflicts = Object.fromEntries(Object.entries(event.conflicts || {}).filter(([field]) => !["discoveredAt", "updatedAt"].includes(field)));
    const detail = shadow.querySelector(".event-detail");
    detail.innerHTML = `<button class="back">← 返回报警</button><div class="detail">
      ${kv("报警来源", event.sourceLabel)}${kv("来源接口", (event.sourceEndpoints || [event.rawEndpoint]).join("、"))}${kv("车牌", event.vehicleNo)}${kv("驾驶员", event.driverName)}${kv("企业", event.companyName)}${kv("报警ID", event.alarmId)}${kv("报警类型", event.alarmName)}${kv("报警时间", event.alarmTime)}${kv("位置", event.location)}${kv("速度", event.locationSpeed == null ? null : `${event.locationSpeed} km/h`)}${kv("平台状态", event.platformStatus)}${kv("报警状态", event.alarmStatus)}${kv("完成状态", event.alarmCompleteStatus)}${kv("处理标记", event.dealFlag)}${kv("事件状态", event.state)}${kv("系统处理状态", item.processing?.status || item.action?.processingStatus || "UNPROCESSED")}${kv("处理状态来源", item.processing?.source)}${kv("处理状态时间", item.processing?.markedAt)}${technicalDetailRows(event)}${kv("规则版本", item.decision?.ruleSetVersion)}${kv("命中规则", item.decision?.ruleId)}${kv("处理方式", item.decision?.action)}${kv("提醒分类", item.decision?.reminderPolicy?.category)}${kv("司机提醒", item.decision?.reminderPolicy?.driverReminder)}${kv("第二渠道", item.decision?.reminderPolicy?.secondaryChannelMode)}${kv("响应渠道", (item.decision?.channels || []).map((channel) => channel.type).join(item.decision?.channelStrategy === "PARALLEL" ? " ＋ " : " → "))}${kv("判断原因", item.decision?.reason)}${kv("完成判定", item.event?.completionAssessment?.status)}${kv("完成判定说明", item.event?.completionAssessment?.reason)}${kv("动作状态", item.action?.status)}${kv("渠道结果", (item.action?.attempts || []).map((attempt) => `${attempt.channelType}:${attempt.status}（重试${attempt.retryCount || 0}次）`).join("；"))}${kv("固定话术", (item.action?.attempts || []).map((attempt) => attempt.renderedText).filter(Boolean).join("；"))}${kv("失败原因", item.action?.error || item.action?.blockers?.join("；"))}${kv("处置工单", disposal?.status || (item.disposalSyncError ? "同步失败" : "未创建"))}${kv("工单负责人", disposal?.assignedTo)}${kv("字段冲突", Object.keys(visibleConflicts).length ? JSON.stringify(visibleConflicts) : "无")}
      ${item.disposalSyncError ? `<div class="notice bad">处置工单同步失败：${escapeHtml(item.disposalSyncError)}</div>` : ""}
      ${disposalControls(item)}
      ${hasPermission("disposal.note") && hasActiveShift() ? `<div class="note-row"><input class="note-input" maxlength="300" placeholder="添加实名值班备注"><button class="save-note">保存</button></div>` : `<div class="notice">${hasPermission("disposal.note") ? "请先在助手身份页认领当前班次。" : "当前实名角色无备注权限，事件保持只读。"}</div>`}
    </div>`;
    detail.querySelector(".back").addEventListener("click", () => showView("events"));
    detail.querySelector(".save-note")?.addEventListener("click", async () => {
      const input = detail.querySelector(".note-input");
      if (!input.value.trim()) return;
      await runtimeSendMessage({ type: "NOTE_ADD", eventId, text: input.value.trim() });
      input.value = "";
      await refresh();
      showEvent(eventId);
    });
    detail.querySelector(".takeover-case")?.addEventListener("click", () => mutateDisposal(eventId, "takeover", {}));
    detail.querySelector(".complete-case")?.addEventListener("click", async () => {
      const note = window.prompt("请输入处置结果说明（将提交复核）");
      if (!note?.trim()) return;
      await mutateDisposal(eventId, "complete", { resolutionCode: "MANUAL_COMPLETED", resolutionNote: note.trim() });
    });
    detail.querySelector(".approve-case")?.addEventListener("click", async () => {
      const comment = window.prompt("请输入复核通过意见");
      if (!comment?.trim()) return;
      await mutateDisposal(eventId, "review", { approved: true, comment: comment.trim() });
    });
    detail.querySelector(".reject-case")?.addEventListener("click", async () => {
      const comment = window.prompt("请输入退回原因");
      if (!comment?.trim()) return;
      await mutateDisposal(eventId, "review", { approved: false, comment: comment.trim() });
    });
    showView("event-detail");
  }

  function disposalControls(item) {
    const disposal = item.disposal;
    if (!disposal) return "";
    if (["MANUAL_REQUIRED", "REOPENED"].includes(disposal.status) && hasPermission("disposal.takeover") && hasActiveShift()) {
      return `<button class="takeover-case primary" style="width:100%;padding:9px;margin-top:9px">接管处置工单</button>`;
    }
    if (disposal.status === "IN_MANUAL" && disposal.assignedToUserId === String(dashboard.identity?.userId) && hasPermission("disposal.complete") && hasActiveShift()) {
      return `<button class="complete-case primary" style="width:100%;padding:9px;margin-top:9px">提交处置结果</button>`;
    }
    if (disposal.status === "PENDING_REVIEW" && hasPermission("disposal.review") && hasActiveShift()) {
      return `<div class="toolbar"><button class="approve-case primary">复核通过</button><button class="reject-case warn">退回补充</button></div>`;
    }
    return "";
  }

  async function mutateDisposal(eventId, operation, payload) {
    const response = await runtimeSendMessage({ type: "DISPOSAL_MUTATE", eventId, operation, payload });
    await refresh();
    showEvent(eventId);
    if (!response?.ok) window.alert(response?.error || "处置操作失败");
  }

  function kv(label, value) {
    return `<div class="kv"><span>${label}</span><strong>${escapeHtml(value ?? "-")}</strong></div>`;
  }

  function technicalDetailRows(event) {
    if (event.sourceKind !== "TECHNICAL") return "";
    const labels = {
      alarmClassification: "技术分类",
      alarmCompleteStatusName: "技术完成状态",
      alarmTimeEnd: "结束时间",
      certColorName: "车牌颜色",
      dealFlag: "处理标记",
      dealResult: "处理结果",
      detail: "技术说明",
      firmwareVersion: "固件版本",
      recorderSpeed: "记录速度",
      speed: "平台速度",
      statusName: "平台状态名称",
      sysType: "系统类型",
      termAlarmno: "终端报警编号",
      traceno: "轨迹编号",
      vehicleModelType: "车型编码",
      vehicleModelTypeName: "车型名称",
      alarmWaitingDuration: "等待时长"
    };
    const details = event.technicalDetails || {};
    const rows = Object.entries(labels)
      .filter(([field]) => details[field] !== null && details[field] !== undefined && details[field] !== "")
      .map(([field, label]) => kv(label, details[field]))
      .join("");
    return `<div class="technical-block"><strong>技术检测明细</strong>${rows || `<div class="muted">接口未返回可展示的诊断字段，需人工核查原平台。</div>`}</div>`;
  }

  function renderCaptures() {
    const records = debugStore.list();
    shadow.querySelector(".captures").innerHTML = `<div class="list">${records.length ? records.map((record) => `<div class="card"><div class="row"><span class="title">${escapeHtml(record.matchedRule)}</span><span class="badge">${escapeHtml(record.status)}</span></div><div class="muted">${escapeHtml(record.method)} · ${escapeHtml(record.durationMs)}ms · ${escapeHtml(record.capturedAt)}</div></div>`).join("") : `<div class="empty">等待白名单接口响应</div>`}</div>`;
  }

  function renderSettings() {
    if (!dashboard) return;
    settingsDirty = false;
    const settings = dashboard.settings;
    const canConfigure = hasPermission("system.configure");
    const disabledConfigure = canConfigure ? "" : "disabled";
    const target = shadow.querySelector(".settings");
    target.innerHTML = `<div class="form">
      <div class="notice ${dashboard.identity?.authenticated ? "" : "bad"}">${dashboard.identity?.authenticated ? `当前实名用户：${escapeHtml(dashboard.identity.displayName)}。权限由助手服务端控制。` : `尚未登录实名助手账号，当前仅允许只读采集。`}</div>
      <label>助手服务器地址<input class="assistant-base" value="${escapeHtml(settings.assistantBase || "http://127.0.0.1:18080/assistant")}" ${disabledConfigure}><small>本机允许 HTTP；远程服务器必须使用 HTTPS 并以 /assistant 结尾。</small></label>
      <div class="notice bad">运行方式固定为“真实自动运行”，不提供演练、沙箱或手工触发模式。</div>
      <label>定点弹窗选择器<textarea class="popup-selectors" placeholder="每行一个已验证的CSS选择器" ${disabledConfigure}>${escapeHtml((settings.popupSelectors || []).join("\n"))}</textarea><small>留空时不扫描DOM；只监听配置的目标容器。</small></label>
      <button class="save-settings primary" ${disabledConfigure}>保存运行设置</button>
      <div class="settings-result muted"></div>
      <div class="notice">运行规则只从后台规则治理中心同步，插件不再接受本地 JSON 或音频导入。当前来源：${escapeHtml(dashboard.ruleSet.source || "未知")}；${dashboard.ruleSet.lastError ? `最近同步提示：${escapeHtml(dashboard.ruleSet.lastError)}` : "已同步后台发布版本。"}</div>
      <div class="notice">会话保活由系统管理员在后台统一配置。采集员只能查看状态；当前白名单覆盖报警预处理页的唯一“查询”，以及实时监控页、预警列表页的只读观察，不导航、不刷新、不点击任意业务按钮。</div>
      <button class="open-rule-center">打开规则治理中心</button>
    </div>`;
    target.querySelectorAll("input,textarea,select").forEach((control) => {
      control.addEventListener("input", () => { settingsDirty = true; });
      control.addEventListener("change", () => { settingsDirty = true; });
    });
    target.querySelector(".save-settings").addEventListener("click", saveSettings);
    target.querySelector(".open-rule-center").addEventListener("click", () => window.open(`${settings.assistantBase || "http://127.0.0.1:18080/assistant"}/rules/`, "_blank", "noopener"));
  }

  async function saveSettings() {
    const target = shadow.querySelector(".settings");
    const popupSelectors = target.querySelector(".popup-selectors").value.split(/\n/).map((item) => item.trim()).filter(Boolean);
    const assistantBase = target.querySelector(".assistant-base").value.trim();
    try {
      const response = await runtimeSendMessage({ type: "SETTINGS_UPDATE", settings: { assistantBase, popupSelectors } });
      if (!response?.ok) return setResult(`保存失败：${response?.error || "扩展后台未返回结果"}`, false);
      settingsDirty = false;
      await refresh();
      setResult("设置已保存", true);
    } catch (error) {
      setResult(`保存失败：${String(error?.message || error)}`, false);
    }
  }

  function setResult(message, ok) {
    const target = shadow.querySelector(".settings-result");
    if (target) { target.textContent = message || "操作失败"; target.style.color = ok ? "#8de1bd" : "#ffaaa4"; }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  async function refresh() {
    try {
      reportPlatformSession();
      await backfillVisibleRealtimeAlarms();
      dashboard = await runtimeSendMessage({ type: "STATUS" });
      if (!dashboard?.ok) throw new Error(dashboard.error || "扩展后台未响应");
      configurePopupObserver(dashboard.settings.popupSelectors || []);
      renderOverview(); renderEvents(); renderCaptures();
      if (!shadow.querySelector(".settings").classList.contains("hidden") && !settingsDirty) renderSettings();
    } catch (error) {
      const message = extensionContextInvalidated
        ? "扩展上下文已失效。请在扩展管理页重新加载扩展，然后刷新此省平台页面。"
        : `扩展后台未响应：${escapeHtml(runtimeErrorMessage(error))}`;
      shadow.querySelector(".overview").innerHTML = `<div class="notice bad">${message}</div>`;
    }
  }

  function configurePopupObserver(selectors) {
    popupObserver?.disconnect(); popupObserver = null;
    if (!selectors.length || !document.documentElement) return;
    const scan = () => {
      for (const selector of selectors) {
        let nodes = [];
        try { nodes = document.querySelectorAll(selector); } catch { continue; }
        for (const node of nodes) {
          if (observedPopups.has(node)) continue;
          observedPopups.add(node);
          const title = node.querySelector?.("[class*='title'],header,h1,h2,h3")?.textContent?.trim() || "目标弹窗";
          const text = node.textContent?.replace(/\s+/g, " ").trim().slice(0, 2000) || "";
          void runtimeSendMessage({ type: "DOM_OBSERVATION", observation: { selector, title, text, observedAt: new Date().toISOString() } });
        }
      }
    };
    popupObserver = new MutationObserver(() => {
      clearTimeout(popupScanTimer);
      popupScanTimer = setTimeout(scan, 300);
    });
    popupObserver.observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }

  refresh();
  window.addEventListener("hashchange", reportPlatformSession);
  document.addEventListener("visibilitychange", reportPlatformSession);
  setInterval(refresh, 1000);
})();
