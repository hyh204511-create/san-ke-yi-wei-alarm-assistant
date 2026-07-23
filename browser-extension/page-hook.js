(() => {
  if (window.__HN_ALARM_COLLECTOR_INSTALLED__) return;
  window.__HN_ALARM_COLLECTOR_INSTALLED__ = true;

  const MAX_TEXT_LENGTH = 5 * 1024 * 1024;
  // Platform requests are listened to first. Polling is only a fallback and
  // must stay at the approved three-second cadence to avoid request storms.
  const REALTIME_POLL_INTERVAL_MS = 3000;
  const REALTIME_MONITOR_ROUTE = /^#\/vehicle-monitor\/real-time(?:$|[/?])/i;
  const REALTIME_POLL_PATH = "/alarm-service/alarm/center/getVideoUnprocessedAlarm";
  const ALARM_QUERY_PATH = "/alarm-service/alarm/center/alarmQueryList";
  const ALARM_POLL_SILENCE_MS = 4500;
  const ALARM_POLL_TIMEOUT_MS = 15000;
  const MAX_ALARM_POLLERS = 8;
  const ALARM_API_ORIGIN = "https://zuul-2k1v.hnznjg.cn:7443";
  const alarmPollers = new Map();
  const nativeRequestSequences = new Map();
  let nativeRequestSequence = 0;
  let authenticationFailureSequence = 0;
  let authenticatedSuccessSequence = 0;
  const ALARM_POLL_TARGETS = Object.freeze([
    Object.freeze({ name: "prewarning-query", path: REALTIME_POLL_PATH, method: "POST" }),
    Object.freeze({ name: "prewarning-query", path: ALARM_QUERY_PATH, method: "POST" }),
    Object.freeze({ name: "realtime-alarms", path: ALARM_QUERY_PATH, method: "POST" }),
    Object.freeze({ name: "pending-alarms", path: "/alarm-service/alarm/center/alarmPreProcessingInfo", method: "POST" }),
    Object.freeze({ name: "technical-alarms", path: "/alarm-service/alarm/center/technology/detection", method: "POST" })
  ]);
  const RULES = [
    ["alarm-types", "/alarm-service/alarmUserSet/listAll", "alarm"],
    ["preprocessing-count", "/alarm-service/alarm/center/alarmPreProcessingCount", "alarm"],
    ["pending-alarms", "/alarm-service/alarm/center/alarmPreProcessingInfo", "alarm"],
    ["alarm-count", "/alarm-service/alarm/center/queryAlarmUnDealCount", "alarm"],
    ["alarm-details", "/alarm-service/alarm/center/alarmDetails", "alarm"],
    ["technical-alarms", "/alarm-service/alarm/center/technology/detection", "alarm"],
    ["vehicle-tree", "/base-service/groupinfo/loadAllVehicleGroupTree", "vehicle"],
    ["vehicle-info", "/base-service/vehicle/getMonitorCarInfo/", "vehicle"],
    ["vehicle-types", "/base-service/vehicle/getMonitorCarBillMapInfo", "vehicle"],
    ["check-post", "/base-service/checkPost/list", "check-post"],
    ["alarm-center-discovery", "/alarm-service/alarm/center/", "discovery"]
  ];
  const REPORT_SOURCE_RULES = Object.freeze([
    Object.freeze({ sourceType: "TRACK_COMPLETENESS", name: "report-track-completeness-discovery", labels: ["轨迹完整率明细"] }),
    Object.freeze({ sourceType: "VEHICLE_BASE_INFO", name: "report-vehicle-base-discovery", labels: ["车辆基础信息"] }),
    Object.freeze({ sourceType: "ALARM_DISPOSAL_RATE", name: "report-alarm-disposal-discovery", labels: ["报警处置率", "处置率报表"] }),
    Object.freeze({ sourceType: "ALARM_PROCESSING_RATE", name: "report-alarm-processing-discovery", labels: ["报警处理率", "处理率报表"] }),
    Object.freeze({ sourceType: "ALARM_CENTER", name: "report-alarm-center-discovery", labels: ["报警查询报表", "报警中心数据"] }),
  ]);
  const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|session|token|mobile|phone|contactInformation|driverNumber|idCard/i;

  function activeReportSource() {
    try {
      const nodes = [...document.querySelectorAll(
        ".is-active,.active,.selected,[aria-selected='true'],[aria-current='page'],.breadcrumb,.el-breadcrumb,.ant-breadcrumb,h1,h2"
      )];
      const visible = nodes
        .filter((node) => !node.getAttribute?.("aria-hidden"))
        .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | ");
      return REPORT_SOURCE_RULES.find((rule) => rule.labels.some((label) => visible.includes(label))) || null;
    } catch {
      return null;
    }
  }

  function matchRule(url, view = {}) {
    const path = new URL(String(url), location.href).pathname.replace(/^\/api/, "");
    const route = view.route ?? location.hash ?? "";
    const activeTab = path.includes(ALARM_QUERY_PATH)
      ? view.activeTab === undefined ? activeMonitorAlarmTab(route) : view.activeTab
      : null;
    if (path.includes("/alarm-service/alarm/center/getVideoUnprocessedAlarm")) {
      const monitorRoute = REALTIME_MONITOR_ROUTE.test(route);
      return { name: monitorRoute ? "prewarning-query" : "realtime-alarms", category: "alarm", path };
    }
    if (path.includes(ALARM_QUERY_PATH)) {
      const realtimeRoute = /^#\/alarm-center\/alarm-verification(?:$|[/?])/i.test(route)
        || activeTab === "REALTIME";
      const prewarningRoute = /^#\/alarm-center\/pr-alarm-recorde(?:$|[/?])/i.test(route)
        || activeTab === "PREWARNING";
      return { name: realtimeRoute ? "realtime-alarms" : prewarningRoute ? "prewarning-query" : "alarm-query", category: "alarm", path };
    }
    const rule = RULES.find(([, fragment]) => path.includes(fragment));
    if (rule) return { name: rule[0], category: rule[2], path };
    const reportSource = activeReportSource();
    return reportSource && path.startsWith("/")
      ? { name: reportSource.name, category: "report-discovery", sourceType: reportSource.sourceType, path }
      : null;
  }

  function activeMonitorAlarmTab(route = location.hash || "") {
    if (!REALTIME_MONITOR_ROUTE.test(route)) return null;
    try {
      const activeNodes = [...document.querySelectorAll(".tab-item,[role='tab'],[class*='tab-item']")].filter((node) => {
        const className = String(node.className || "");
        const hasClass = (name) => node.classList?.contains(name) || (` ${className} `).includes(` ${name} `);
        return hasClass("active") || hasClass("tab-active") || hasClass("is-active") || node.getAttribute?.("aria-selected") === "true";
      });
      const activeText = activeNodes.map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim());
      if (activeText.some((text) => /^实时报警(?:\s+\d+)?$/.test(text))) return "REALTIME";
      if (activeText.some((text) => /^预警列表(?:\s+\d+)?$/.test(text))) return "PREWARNING";
    } catch {}
    return null;
  }

  function resolveResponseRule(rule, requestRoute, requestActiveTab) {
    if (!rule?.path?.includes(ALARM_QUERY_PATH) || requestActiveTab || location.hash !== requestRoute) return rule;
    const responseActiveTab = activeMonitorAlarmTab(requestRoute);
    if (!responseActiveTab && REALTIME_MONITOR_ROUTE.test(requestRoute)) {
      return { ...rule, name: "alarm-center-discovery", category: "discovery" };
    }
    return matchRule(rule.path, { route: requestRoute, activeTab: responseActiveTab }) || rule;
  }

  function isAlarmQueryUrl(url) {
    try {
      return new URL(String(url), location.href).pathname.replace(/^\/api/, "").includes(ALARM_QUERY_PATH);
    } catch {
      return false;
    }
  }

  function redact(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen)
      ])
    );
  }

  function parseBody(value) {
    if (value == null) return null;
    if (typeof value !== "string") {
      if (value instanceof URLSearchParams) value = value.toString();
      else if (value instanceof FormData) {
        return redact(Object.fromEntries([...value.entries()].map(([key, item]) => [
          key,
          typeof item === "string" ? item : `[File ${item.name || "binary"}]`
        ])));
      } else return `[${value.constructor?.name || typeof value}]`;
    }

    const text = value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
    try {
      return redact(JSON.parse(text));
    } catch {
      try {
        return redact(Object.fromEntries(new URLSearchParams(text)));
      } catch {
        return text;
      }
    }
  }

  function safeHeaders(headers) {
    if (!headers) return {};
    try {
      return Object.fromEntries(
        [...new Headers(headers).entries()]
          .filter(([key]) => !SENSITIVE_KEY.test(key))
      );
    } catch {
      return {};
    }
  }

  function parseResponse(text, contentType) {
    const truncated = text.length > MAX_TEXT_LENGTH;
    const value = truncated ? text.slice(0, MAX_TEXT_LENGTH) : text;
    if (contentType.includes("json")) {
      try {
        return { body: redact(JSON.parse(value)), truncated };
      } catch {}
    }
    return { body: value, truncated };
  }

  function sanitizeUrl(value) {
    try {
      const url = new URL(String(value), location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_KEY.test(key) || /^(?:code|captcha|sign|signature)$/i.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      url.hash = sanitizeRoute(url.hash);
      return url.href;
    } catch {
      return String(value || "").split("?")[0];
    }
  }

  function sanitizeRoute(value) {
    const route = String(value || "");
    const separator = route.indexOf("?");
    if (separator < 0) return route;
    const params = new URLSearchParams(route.slice(separator + 1));
    for (const key of [...params.keys()]) {
      if (SENSITIVE_KEY.test(key) || /^(?:code|captcha|sign|signature)$/i.test(key)) {
        params.set(key, "[REDACTED]");
      }
    }
    return `${route.slice(0, separator)}?${params}`;
  }

  function emit(record) {
    window.postMessage({
      source: "hn-alarm-collector-page",
      record: {
        schemaVersion: 1,
        captureId: crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
        pageUrl: sanitizeUrl(location.href),
        route: sanitizeRoute(location.hash),
        isAlarm: record.category === "alarm",
        ...record,
        url: record.url ? sanitizeUrl(record.url) : record.url,
        route: sanitizeRoute(record.route ?? location.hash)
      }
    }, location.origin);
  }

  function parseSharedWorkerPayload(value, depth = 0, seen = new WeakSet()) {
    if (value == null) return null;
    if (depth > 4) return null;
    if (typeof value === "string") {
      if (value.length > MAX_TEXT_LENGTH) return null;
      try { return parseSharedWorkerPayload(JSON.parse(value)); } catch { return null; }
    }
    if (typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (value.funCode) return value;
    for (const nested of [value.data, value.body, value.message]) {
      const payload = parseSharedWorkerPayload(nested, depth + 1, seen);
      if (payload) return payload;
    }
    return null;
  }

  function captureSharedWorkerMessage(event) {
    const payload = parseSharedWorkerPayload(event?.data ?? event);
    if (!payload || payload.funCode !== "ALARM_ADD" || String(payload.alarmKind) !== "1") return;
    emit({
      transport: "shared-worker-message",
      method: "MESSAGE",
      url: location.href,
      path: "/shared-worker/ALARM_ADD",
      matchedRule: "realtime-alarms",
      category: "alarm",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      status: 200,
      ok: true,
      request: { headers: {}, body: null },
      response: {
        headers: {},
        contentType: "application/json",
        body: redact(payload),
        truncated: false
      }
    });
  }

  function installSharedWorkerObserver() {
    const NativeSharedWorker = window.SharedWorker;
    if (typeof NativeSharedWorker !== "function" || window.__HN_ALARM_SHARED_WORKER_OBSERVER__) return;
    try {
      const ObservedSharedWorker = new Proxy(NativeSharedWorker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget);
          try {
            const port = worker?.port;
            if (port && typeof port.addEventListener === "function") {
              port.addEventListener("message", captureSharedWorkerMessage);
              if (typeof port.start === "function") port.start();
            }
          } catch {}
          return worker;
        }
      });
      window.SharedWorker = ObservedSharedWorker;
      window.__HN_ALARM_SHARED_WORKER_OBSERVER__ = true;
    } catch {}
  }

  function isAlarmPollTarget(rule, method, url) {
    if (rule?.category !== "alarm") return false;
    let origin;
    try { origin = new URL(String(url), location.href).origin; } catch { return false; }
    if (origin !== ALARM_API_ORIGIN) return false;
    return ALARM_POLL_TARGETS.some((target) => target.name === rule.name
      && target.path === rule.path
      && target.method === String(method || "").toUpperCase());
  }

  function requestFingerprint(method, url, body) {
    const source = `${method}\n${url}\n${typeof body === "string" ? body : String(body ?? "")}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function pollerKey(rule, method, url, body) {
    return `${rule.name}:${rule.path}:${requestFingerprint(method, url, body)}`;
  }

  function registerAlarmPoll({ key, rule, route, execute, responseText }) {
    if (typeof execute !== "function") return;
    const existing = alarmPollers.get(key);
    if (!existing && alarmPollers.size >= MAX_ALARM_POLLERS) {
      const sourceCounts = new Map();
      for (const candidate of alarmPollers.values()) {
        sourceCounts.set(candidate.rule.name, (sourceCounts.get(candidate.rule.name) || 0) + 1);
      }
      const oldest = [...alarmPollers.entries()]
        .filter(([, candidate]) => (sourceCounts.get(candidate.rule.name) || 0) > 1)
        .sort((left, right) => left[1].lastNativeAt - right[1].lastNativeAt)[0];
      if (!oldest) return;
      if (oldest) alarmPollers.delete(oldest[0]);
    }
    const poller = existing || {
      key,
      inFlight: false,
      generation: 0
    };
    poller.rule = { ...rule };
    poller.route = route;
    poller.execute = execute;
    poller.lastNativeAt = Date.now();
    poller.lastResponseSignature = responseSignature(responseText);
    poller.failures = 0;
    poller.generation += 1;
    alarmPollers.set(key, poller);
  }

  function responseSignature(text) {
    return `${String(text || "").length}:${requestFingerprint("", "", text)}`;
  }

  function beginNativeRequest(rule, method, url) {
    let origin;
    try { origin = new URL(String(url), location.href).origin; } catch { return null; }
    const approvedPath = ALARM_POLL_TARGETS.some((target) => target.path === rule?.path
      && target.method === String(method || "").toUpperCase());
    if (!approvedPath || origin !== ALARM_API_ORIGIN) return null;
    const sequenceKey = `${String(method || "").toUpperCase()}:${rule.path}`;
    const sequence = ++nativeRequestSequence;
    nativeRequestSequences.set(sequenceKey, sequence);
    const observedAt = Date.now();
    for (const poller of alarmPollers.values()) {
      if (poller.rule.path === rule.path) poller.lastNativeAt = observedAt;
    }
    return { sequenceKey, sequence };
  }

  function isLatestNativeRequest(nativeRequest) {
    return nativeRequest && nativeRequestSequences.get(nativeRequest.sequenceKey) === nativeRequest.sequence;
  }

  function acceptNativeSuccess(nativeRequest) {
    if (!isLatestNativeRequest(nativeRequest) || nativeRequest.sequence <= authenticationFailureSequence) return false;
    authenticatedSuccessSequence = Math.max(authenticatedSuccessSequence, nativeRequest.sequence);
    return true;
  }

  function acceptNativeAuthenticationFailure(nativeRequest) {
    if (!nativeRequest || nativeRequest.sequence < authenticatedSuccessSequence) return false;
    authenticationFailureSequence = Math.max(authenticationFailureSequence, nativeRequest.sequence);
    return true;
  }

  function acceptFallbackAuthenticationFailure() {
    authenticationFailureSequence = ++nativeRequestSequence;
    alarmPollers.clear();
  }

  function reportRealtimePoll(status, changed, poller) {
    window.postMessage({
      source: "hn-alarm-realtime-poll",
      status,
      changed: Boolean(changed),
      matchedRule: poller?.rule?.name || null,
      path: poller?.rule?.path || null,
      polledAt: new Date().toISOString()
    }, location.origin);
  }

  async function runAlarmPoller(poller) {
    if (poller.inFlight || Date.now() - poller.lastNativeAt < ALARM_POLL_SILENCE_MS) return;
    poller.inFlight = true;
    const generation = poller.generation;
    try {
      const result = await poller.execute();
      if (alarmPollers.get(poller.key) !== poller || poller.generation !== generation) return;
      const status = Number(result?.status || 0);
      const nextSignature = responseSignature(result?.responseText);
      const changed = nextSignature !== poller.lastResponseSignature;
      reportRealtimePoll(status, changed, poller);
      if (status === 401 || status === 403) {
        acceptFallbackAuthenticationFailure();
        return;
      }
      if (status >= 200 && status < 400) {
        poller.failures = 0;
        if (changed) {
          poller.lastResponseSignature = nextSignature;
          result.emitRecord?.(poller);
        }
      } else {
        poller.failures += 1;
      }
    } catch {
      if (alarmPollers.get(poller.key) === poller && poller.generation === generation) poller.failures += 1;
    } finally {
      poller.inFlight = false;
      if (poller.generation === generation && poller.failures >= 3) alarmPollers.delete(poller.key);
    }
  }

  async function runAlarmPollers() {
    await Promise.all([...alarmPollers.values()].map(runAlarmPoller));
  }

  function isReplayableFetchBody(body) {
    return body == null || typeof body === "string";
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const startedAt = Date.now();
    const startedMark = performance.now();
    const input = args[0];
    const init = args[1] || {};
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const requestRoute = location.hash || "";
    const requestActiveTab = isAlarmQueryUrl(url) ? activeMonitorAlarmTab(requestRoute) : null;
    const rule = matchRule(url, { route: requestRoute, activeTab: requestActiveTab });
    const method = String(init.method || input.method || "GET").toUpperCase();
    const requestHeaders = safeHeaders(init.headers || input.headers);
    let replayRequestSeed = null;
    if (input instanceof Request) {
      try { replayRequestSeed = input.clone(); } catch {}
    }
    const requestBodyPromise = init.body != null
      ? Promise.resolve(parseBody(init.body))
      : replayRequestSeed
        ? replayRequestSeed.clone().text().then(parseBody).catch(() => null)
        : Promise.resolve(null);
    const requestFingerprintBodyPromise = init.body != null
      ? Promise.resolve(typeof init.body === "string" ? init.body : "")
      : replayRequestSeed
        ? replayRequestSeed.clone().text().catch(() => "")
        : Promise.resolve("");

    const absoluteUrl = new URL(url, location.href).href;
    const nativeRequest = beginNativeRequest(rule, method, absoluteUrl);
    const responsePromise = originalFetch.apply(this, args);
    if (!rule) return responsePromise;

    responsePromise.then((response) => {
      void Promise.all([
        requestBodyPromise,
        requestFingerprintBodyPromise,
        response.clone().text().catch(() => "")
      ]).then(([requestBody, requestFingerprintBody, responseText]) => {
        const responseRule = resolveResponseRule(rule, requestRoute, requestActiveTab);
        const authenticationFailure = (response.status === 401 || response.status === 403)
          && acceptNativeAuthenticationFailure(nativeRequest);
        const acceptedNativeSuccess = response.ok && acceptNativeSuccess(nativeRequest);
        if (authenticationFailure) alarmPollers.clear();
        const contentType = response.headers.get("content-type") || "";
        emit({
          transport: "fetch",
          method,
          url: new URL(url, location.href).href,
          route: requestRoute,
          path: responseRule.path,
          matchedRule: responseRule.name,
          category: responseRule.category,
          reportSourceType: responseRule.sourceType || null,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Math.round(performance.now() - startedMark),
          status: response.status,
          ok: response.ok,
          request: { headers: requestHeaders, body: requestBody },
          response: {
            headers: safeHeaders(response.headers),
            contentType,
            ...parseResponse(responseText, contentType)
          }
        });
        if (acceptedNativeSuccess && isAlarmPollTarget(responseRule, method, absoluteUrl)
          && isReplayableFetchBody(init.body)
          && (!(input instanceof Request) || replayRequestSeed)) {
          const replayInit = { ...init };
          delete replayInit.signal;
          if (init.headers) replayInit.headers = new Headers(init.headers);
          const key = pollerKey(responseRule, method, absoluteUrl, requestFingerprintBody);
          registerAlarmPoll({ key, rule: responseRule, route: requestRoute, responseText, execute: async () => {
            const pollStartedAt = Date.now();
            const pollStartedMark = performance.now();
            const controller = new AbortController();
            const nextInput = replayRequestSeed
              ? new Request(replayRequestSeed.clone(), { signal: controller.signal })
              : absoluteUrl;
            replayInit.signal = controller.signal;
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
              timeoutId = setTimeout(() => {
                controller.abort();
                reject(new Error("alarm poll timeout"));
              }, ALARM_POLL_TIMEOUT_MS);
            });
            const pollResponse = await Promise.race([
              originalFetch.call(window, nextInput, replayInit),
              timeoutPromise
            ]).finally(() => clearTimeout(timeoutId));
            const pollText = await pollResponse.clone().text().catch(() => "");
            const pollContentType = pollResponse.headers.get("content-type") || "";
            return {
              status: pollResponse.status,
              responseText: pollText,
              emitRecord: (poller) => {
                emit({
                  transport: "fetch-poll", method, url: absoluteUrl, route: poller.route,
                  path: poller.rule.path, matchedRule: poller.rule.name, category: poller.rule.category, startedAt: new Date(pollStartedAt).toISOString(),
                  durationMs: Math.round(performance.now() - pollStartedMark), status: pollResponse.status, ok: pollResponse.ok,
                  request: { headers: requestHeaders, body: requestBody },
                  response: { headers: safeHeaders(pollResponse.headers), contentType: pollContentType, ...parseResponse(pollText, pollContentType) }
                });
              }
            };
          }});
        }
      });
    }).catch((error) => {
      emit({
        transport: "fetch",
        method,
        url: new URL(url, location.href).href,
        path: rule.path,
        matchedRule: rule.name,
        category: rule.category,
        reportSourceType: rule.sourceType || null,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Math.round(performance.now() - startedMark),
        status: 0,
        ok: false,
        error: String(error?.message || error),
        request: { headers: requestHeaders, body: null },
        response: null
      });
    });
    return responsePromise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const alarmPollReplay = this.__hnAlarmPollReplay === true;
    const requestRoute = location.hash || "";
    const requestActiveTab = isAlarmQueryUrl(url) ? activeMonitorAlarmTab(requestRoute) : null;
    this.__hnCollector = {
      method: String(method).toUpperCase(),
      url: new URL(String(url), location.href).href,
      route: requestRoute,
      activeTab: requestActiveTab,
      rule: matchRule(url, { route: requestRoute, activeTab: requestActiveTab }),
      headers: {},
      replayHeaders: {},
      openRest: [...rest],
      alarmPollReplay
    };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__hnCollector) this.__hnCollector.replayHeaders[name] = value;
    if (this.__hnCollector && !SENSITIVE_KEY.test(name)) {
      this.__hnCollector.headers[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__hnCollector;
    if (meta?.rule && !meta.alarmPollReplay) {
      const nativeRequest = beginNativeRequest(meta.rule, meta.method, meta.url);
      const startedAt = Date.now();
      const startedMark = performance.now();
      const replayOptions = {
        withCredentials: this.withCredentials,
        timeout: this.timeout,
        responseType: this.responseType
      };
      this.addEventListener("loadend", () => {
        const responseRule = resolveResponseRule(meta.rule, meta.route, meta.activeTab);
        const authenticationFailure = (this.status === 401 || this.status === 403)
          && acceptNativeAuthenticationFailure(nativeRequest);
        const acceptedNativeSuccess = this.status >= 200 && this.status < 400
          && acceptNativeSuccess(nativeRequest);
        if (authenticationFailure) alarmPollers.clear();
        let responseText = "";
        try {
          if (!this.responseType || this.responseType === "text") responseText = this.responseText || "";
          else if (this.responseType === "json") responseText = JSON.stringify(this.response);
          else responseText = `[${this.responseType} response omitted]`;
        } catch {
          responseText = "[response unavailable]";
        }
        const contentType = this.getResponseHeader("content-type") || "";
        emit({
          transport: "xhr",
          method: meta.method,
          url: meta.url,
          route: meta.route,
          path: responseRule.path,
          matchedRule: responseRule.name,
          category: responseRule.category,
          reportSourceType: responseRule.sourceType || null,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Math.round(performance.now() - startedMark),
          status: this.status,
          ok: this.status >= 200 && this.status < 400,
          request: { headers: meta.headers, body: parseBody(body) },
          response: { headers: {}, contentType, ...parseResponse(responseText, contentType) }
        });
        if (acceptedNativeSuccess
          && isAlarmPollTarget(responseRule, meta.method, meta.url) && isReplayableFetchBody(body)) {
          const replayBody = body == null ? null : String(body);
          const replayHeaders = { ...meta.replayHeaders };
          const key = pollerKey(responseRule, meta.method, meta.url, replayBody);
          registerAlarmPoll({ key, rule: responseRule, route: meta.route, responseText, execute: () => new Promise((resolve) => {
            const pollStartedAt = Date.now();
            const pollStartedMark = performance.now();
            const poll = new XMLHttpRequest();
            poll.__hnAlarmPollReplay = true;
            poll.open(meta.method, meta.url, ...meta.openRest);
            poll.withCredentials = replayOptions.withCredentials;
            poll.timeout = replayOptions.timeout > 0
              ? Math.min(replayOptions.timeout, ALARM_POLL_TIMEOUT_MS)
              : ALARM_POLL_TIMEOUT_MS;
            poll.responseType = replayOptions.responseType;
            for (const [name, value] of Object.entries(replayHeaders)) poll.setRequestHeader(name, value);
            poll.addEventListener("loadend", () => {
              let pollText = "";
              try {
                if (!poll.responseType || poll.responseType === "text") pollText = poll.responseText || "";
                else if (poll.responseType === "json") pollText = JSON.stringify(poll.response);
                else pollText = `[${poll.responseType} response omitted]`;
              } catch {
                pollText = "[response unavailable]";
              }
              const pollContentType = poll.getResponseHeader("content-type") || "";
              resolve({
                status: poll.status,
                responseText: pollText,
                emitRecord: (poller) => emit({
                  transport: "xhr-poll",
                  method: meta.method,
                  url: meta.url,
                  route: poller.route,
                  path: poller.rule.path,
                  matchedRule: poller.rule.name,
                  category: poller.rule.category,
                  startedAt: new Date(pollStartedAt).toISOString(),
                  durationMs: Math.round(performance.now() - pollStartedMark),
                  status: poll.status,
                  ok: poll.status >= 200 && poll.status < 400,
                  request: { headers: meta.headers, body: parseBody(replayBody) },
                  response: { headers: {}, contentType: pollContentType, ...parseResponse(pollText, pollContentType) }
                })
              });
            }, { once: true });
            poll.send(replayBody);
          }) });
        }
      }, { once: true });
    }
    return originalSend.call(this, body);
  };

  installSharedWorkerObserver();
  setInterval(() => {
    void runAlarmPollers();
  }, REALTIME_POLL_INTERVAL_MS);
})();
