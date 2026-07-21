(() => {
  const TARGETS = Object.freeze([
    Object.freeze({ route: "#/alarm-center/alarm-preprocessing", actionKey: "ALARM_PREPROCESSING_QUERY", mode: "CLICK_QUERY" }),
    Object.freeze({ route: "#/vehicle-monitor/real-time", actionKey: "REALTIME_MONITOR_OBSERVE", mode: "READ_ONLY_OBSERVE" }),
    Object.freeze({ route: "#/alarm-center/pr-alarm-recorde", actionKey: "PREWARNING_LIST_OBSERVE", mode: "READ_ONLY_OBSERVE" }),
  ]);
  const CHALLENGE_PATTERN = /(验证码|人机验证|安全验证|滑动验证|请完成验证|captcha|challenge)/i;

  function visible(element) {
    if (!element || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
    const style = globalThis.getComputedStyle?.(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    const rect = element.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  function normalizedLabel(element) {
    return String(element?.value || element?.textContent || element?.getAttribute?.("aria-label") || "").replace(/\s+/g, "").trim();
  }

  function challengePresent(document) {
    const selectors = [
      'input[placeholder*="验证码"]', '[class*="captcha" i]', '[id*="captcha" i]',
      '[class*="verify" i]', '[class*="challenge" i]', '[aria-label*="验证码"]'
    ];
    if (selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(visible))) return true;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"],.el-dialog,.ant-modal,.modal'));
    return dialogs.some((node) => visible(node) && CHALLENGE_PATTERN.test(String(node.textContent || "").slice(0, 500)));
  }

  function loginPresent(document, route) {
    if (/^#\/login(?:$|[/?])/i.test(route)) return true;
    const loginInputs = [
      'input[type="password"]', 'input[placeholder*="密码"]', 'input[placeholder*="手机号"]'
    ].filter((selector) => document.querySelector(selector)).length;
    return loginInputs >= 2;
  }

  function targetFor(route) {
    return TARGETS.find((target) => target.route === route) || null;
  }

  function execute({ document, location }) {
    const started = Date.now();
    const route = String(location?.hash || "");
    const routeKey = route.split("?")[0];
    const safeRoute = routeKey.replace(/[^#A-Za-z0-9_./-]/g, "").slice(0, 160);
    const target = targetFor(routeKey);
    const finish = (code) => ({ ok: code === "SUCCESS", code, route: safeRoute, actionKey: target?.actionKey || "", mode: target?.mode || "", latencyMs: Date.now() - started });
    const hostname = String(location?.hostname || "");
    if (!(hostname === "hnznjg.cn" || hostname.endsWith(".hnznjg.cn"))) return finish("ROUTE_NOT_APPROVED");
    if (loginPresent(document, route)) return finish("LOGIN_REQUIRED");
    if (challengePresent(document)) return finish("CHALLENGE_DETECTED");
    if (!target) return finish("ROUTE_NOT_APPROVED");
    // Observation targets intentionally perform no click, navigation or
    // refresh. Their normal page polling is sufficient to keep the session
    // active and the audit records that the page was safely observed.
    if (target.mode === "READ_ONLY_OBSERVE") return finish("SUCCESS");
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'))
      .filter((element) => visible(element) && normalizedLabel(element) === "查询");
    if (!candidates.length) return finish("TARGET_NOT_FOUND");
    if (candidates.length !== 1) return finish("TARGET_AMBIGUOUS");
    if (route !== String(location?.hash || "") || challengePresent(document)) return finish("CHALLENGE_DETECTED");
    candidates[0].click();
    return finish("SUCCESS");
  }

  globalThis.HnAuthorizedKeepalive = Object.freeze({ TARGETS, execute });
})();
