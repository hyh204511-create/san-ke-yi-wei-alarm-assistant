(() => {
  if (window.__HN_ALARM_COLLECTOR_INSTALLED__) return;
  window.__HN_ALARM_COLLECTOR_INSTALLED__ = true;

  const MAX_TEXT_LENGTH = 5 * 1024 * 1024;
  // Platform requests are listened to first. Polling is only a fallback and
  // must stay at the approved three-second cadence to avoid request storms.
  const REALTIME_POLL_INTERVAL_MS = 3000;
  const REALTIME_MONITOR_ROUTE = /^#\/vehicle-monitor\/real-time(?:$|[/?])/i;
  const REALTIME_POLL_PATH = "/alarm-service/alarm/center/getVideoUnprocessedAlarm";
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

  function matchRule(url) {
    const path = new URL(String(url), location.href).pathname.replace(/^\/api/, "");
    if (path.includes("/alarm-service/alarm/center/getVideoUnprocessedAlarm")) {
      const monitorRoute = /^#\/vehicle-monitor\/real-time(?:$|[/?])/i.test(location.hash || "");
      return { name: monitorRoute ? "prewarning-query" : "realtime-alarms", category: "alarm", path };
    }
    if (path.includes("/alarm-service/alarm/center/alarmQueryList")) {
      const realtimeRoute = /^#\/alarm-center\/alarm-verification(?:$|[/?])/i.test(location.hash || "");
      const prewarningRoute = /^#\/alarm-center\/pr-alarm-recorde(?:$|[/?])/i.test(location.hash || "");
      return { name: realtimeRoute ? "realtime-alarms" : prewarningRoute ? "prewarning-query" : "alarm-query", category: "alarm", path };
    }
    const rule = RULES.find(([, fragment]) => path.includes(fragment));
    return rule ? { name: rule[0], category: rule[2], path } : null;
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

  function isRealtimePollTarget(rule) {
    return Boolean(rule?.path?.includes(REALTIME_POLL_PATH) && REALTIME_MONITOR_ROUTE.test(location.hash || ""));
  }

  function registerRealtimePoll(rule, execute) {
    if (!isRealtimePollTarget(rule) || typeof execute !== "function") return;
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
    const rule = matchRule(url);
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
        const contentType = response.headers.get("content-type") || "";
        emit({
          transport: "fetch",
          method,
          url: new URL(url, location.href).href,
          path: rule.path,
          matchedRule: rule.name,
          category: rule.category,
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
        if (response.ok && isRealtimePollTarget(rule)) {
          lastRealtimeResponseText = responseText;
          const replayInput = input instanceof Request ? input.clone() : input;
          const replayInit = { ...init };
          registerRealtimePoll(rule, async () => {
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
                transport: "fetch-poll", method, url: new URL(url, location.href).href, path: rule.path,
                matchedRule: rule.name, category: rule.category, startedAt: new Date(pollStartedAt).toISOString(),
                durationMs: Math.round(performance.now() - pollStartedMark), status: pollResponse.status, ok: pollResponse.ok,
                request: { headers: requestHeaders, body: requestBody },
                response: { headers: safeHeaders(pollResponse.headers), contentType: pollContentType, ...parseResponse(pollText, pollContentType) }
              });
            }
            return pollResponse.status;
          });
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
    this.__hnCollector = {
      method: String(method).toUpperCase(),
      url: new URL(String(url), location.href).href,
      rule: matchRule(url),
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
        let responseText = "";
        try {
          if (!this.responseType || this.responseType === "text") responseText = this.responseText || "";
          else if (this.responseType === "json") responseText = JSON.stringify(this.response);
          else responseText = `[${this.responseType} response omitted]`;
        } catch {
          responseText = "[response unavailable]";
        }
        const contentType = this.getResponseHeader("content-type") || "";
        const realtimeTarget = isRealtimePollTarget(meta.rule);
        const changed = !realtimeTarget || responseText !== lastRealtimeResponseText;
        if (meta.realtimePollReplay) reportRealtimePoll(this.status, changed);
        if (!meta.realtimePollReplay || changed) {
          if (realtimeTarget) lastRealtimeResponseText = responseText;
          emit({
            transport: meta.realtimePollReplay ? "xhr-poll" : "xhr",
            method: meta.method,
            url: meta.url,
            path: meta.rule.path,
            matchedRule: meta.rule.name,
            category: meta.rule.category,
            startedAt: new Date(startedAt).toISOString(),
            durationMs: Math.round(performance.now() - startedMark),
            status: this.status,
            ok: this.status >= 200 && this.status < 400,
            request: { headers: meta.headers, body: parseBody(body) },
            response: { headers: {}, contentType, ...parseResponse(responseText, contentType) }
          });
        }
        if (this.status >= 200 && this.status < 400 && isRealtimePollTarget(meta.rule)) {
          const replayBody = body;
          const replayHeaders = { ...meta.replayHeaders };
          registerRealtimePoll(meta.rule, () => new Promise((resolve) => {
            const poll = new XMLHttpRequest();
            poll.__hnRealtimePollReplay = true;
            poll.open(meta.method, meta.url, true);
            for (const [name, value] of Object.entries(replayHeaders)) poll.setRequestHeader(name, value);
            poll.addEventListener("loadend", () => resolve(poll.status), { once: true });
            poll.send(replayBody);
          }));
        }
      }, { once: true });
    }
    return originalSend.call(this, body);
  };

  setInterval(runRealtimePoll, REALTIME_POLL_INTERVAL_MS);
})();
