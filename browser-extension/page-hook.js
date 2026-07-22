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
  let realtimePoll = null;
  let realtimePollInFlight = false;
  let realtimePollFailures = 0;
  let lastRealtimeResponseText = null;
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
  const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|session|token|mobile|phone|contactInformation|driverNumber|idCard/i;

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
    return rule ? { name: rule[0], category: rule[2], path } : null;
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

  function emit(record) {
    window.postMessage({
      source: "hn-alarm-collector-page",
      record: {
        schemaVersion: 1,
        captureId: crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
        pageUrl: location.href,
        route: location.hash,
        isAlarm: record.category === "alarm",
        ...record
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

  function isRealtimePollTarget(rule, route = location.hash || "") {
    return Boolean(rule?.path?.includes(REALTIME_POLL_PATH) && REALTIME_MONITOR_ROUTE.test(route));
  }

  function registerRealtimePoll(rule, execute, route = location.hash || "") {
    if (!isRealtimePollTarget(rule, route) || typeof execute !== "function") return;
    realtimePoll = execute;
    realtimePollFailures = 0;
  }

  function reportRealtimePoll(status, changed) {
    window.postMessage({
      source: "hn-alarm-realtime-poll",
      status,
      changed: Boolean(changed),
      polledAt: new Date().toISOString()
    }, location.origin);
  }

  async function runRealtimePoll() {
    if (!REALTIME_MONITOR_ROUTE.test(location.hash || "") || !realtimePoll || realtimePollInFlight) return;
    realtimePollInFlight = true;
    try {
      const status = await realtimePoll();
      if (status === 401 || status === 403) realtimePoll = null;
      realtimePollFailures = status >= 200 && status < 400 ? 0 : realtimePollFailures + 1;
      if (realtimePollFailures >= 3) realtimePoll = null;
    } catch {
      realtimePollFailures += 1;
      if (realtimePollFailures >= 3) realtimePoll = null;
    } finally {
      realtimePollInFlight = false;
    }
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
    const requestBodyPromise = init.body != null
      ? Promise.resolve(parseBody(init.body))
      : input instanceof Request
        ? input.clone().text().then(parseBody).catch(() => null)
        : Promise.resolve(null);

    const responsePromise = originalFetch.apply(this, args);
    if (!rule) return responsePromise;

    responsePromise.then((response) => {
      void Promise.all([
        requestBodyPromise,
        response.clone().text().catch(() => "")
      ]).then(([requestBody, responseText]) => {
        const responseRule = resolveResponseRule(rule, requestRoute, requestActiveTab);
        const contentType = response.headers.get("content-type") || "";
        emit({
          transport: "fetch",
          method,
          url: new URL(url, location.href).href,
          route: requestRoute,
          path: responseRule.path,
          matchedRule: responseRule.name,
          category: responseRule.category,
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
        if (response.ok && isRealtimePollTarget(responseRule, requestRoute)) {
          lastRealtimeResponseText = responseText;
          const replayInput = input instanceof Request ? input.clone() : input;
          const replayInit = { ...init };
          registerRealtimePoll(responseRule, async () => {
            const pollStartedAt = Date.now();
            const pollStartedMark = performance.now();
            const nextInput = replayInput instanceof Request ? replayInput.clone() : replayInput;
            const pollResponse = await originalFetch.call(window, nextInput, replayInit);
            const pollText = await pollResponse.clone().text().catch(() => "");
            const pollContentType = pollResponse.headers.get("content-type") || "";
            const changed = pollText !== lastRealtimeResponseText;
            reportRealtimePoll(pollResponse.status, changed);
            if (changed) {
              lastRealtimeResponseText = pollText;
              emit({
                transport: "fetch-poll", method, url: new URL(url, location.href).href, route: requestRoute,
                path: responseRule.path, matchedRule: responseRule.name, category: responseRule.category, startedAt: new Date(pollStartedAt).toISOString(),
                durationMs: Math.round(performance.now() - pollStartedMark), status: pollResponse.status, ok: pollResponse.ok,
                request: { headers: requestHeaders, body: requestBody },
                response: { headers: safeHeaders(pollResponse.headers), contentType: pollContentType, ...parseResponse(pollText, pollContentType) }
              });
            }
            return pollResponse.status;
          }, requestRoute);
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
    const realtimePollReplay = this.__hnRealtimePollReplay === true;
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
      realtimePollReplay
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
    if (meta?.rule) {
      const startedAt = Date.now();
      const startedMark = performance.now();
      this.addEventListener("loadend", () => {
        const responseRule = resolveResponseRule(meta.rule, meta.route, meta.activeTab);
        let responseText = "";
        try {
          if (!this.responseType || this.responseType === "text") responseText = this.responseText || "";
          else if (this.responseType === "json") responseText = JSON.stringify(this.response);
          else responseText = `[${this.responseType} response omitted]`;
        } catch {
          responseText = "[response unavailable]";
        }
        const contentType = this.getResponseHeader("content-type") || "";
        const realtimeTarget = isRealtimePollTarget(responseRule, meta.route);
        const changed = !realtimeTarget || responseText !== lastRealtimeResponseText;
        if (meta.realtimePollReplay) reportRealtimePoll(this.status, changed);
        if (!meta.realtimePollReplay || changed) {
          if (realtimeTarget) lastRealtimeResponseText = responseText;
          emit({
            transport: meta.realtimePollReplay ? "xhr-poll" : "xhr",
            method: meta.method,
            url: meta.url,
            route: meta.route,
            path: responseRule.path,
            matchedRule: responseRule.name,
            category: responseRule.category,
            startedAt: new Date(startedAt).toISOString(),
            durationMs: Math.round(performance.now() - startedMark),
            status: this.status,
            ok: this.status >= 200 && this.status < 400,
            request: { headers: meta.headers, body: parseBody(body) },
            response: { headers: {}, contentType, ...parseResponse(responseText, contentType) }
          });
        }
        if (this.status >= 200 && this.status < 400 && isRealtimePollTarget(responseRule, meta.route)) {
          const replayBody = body;
          const replayHeaders = { ...meta.replayHeaders };
          registerRealtimePoll(responseRule, () => new Promise((resolve) => {
            const poll = new XMLHttpRequest();
            poll.__hnRealtimePollReplay = true;
            poll.open(meta.method, meta.url, true);
            for (const [name, value] of Object.entries(replayHeaders)) poll.setRequestHeader(name, value);
            poll.addEventListener("loadend", () => resolve(poll.status), { once: true });
            poll.send(replayBody);
          }), meta.route);
        }
      }, { once: true });
    }
    return originalSend.call(this, body);
  };

  installSharedWorkerObserver();
  setInterval(runRealtimePoll, REALTIME_POLL_INTERVAL_MS);
})();
