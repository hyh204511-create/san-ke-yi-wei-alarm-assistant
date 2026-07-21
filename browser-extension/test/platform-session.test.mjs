import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPlatformSession,
  normalizePlatformSession,
  platformSessionBlocker,
  platformSessionFromCapture
} from "../platform-session.js";

test("登录失效后进入人工重登录和断点补采状态", () => {
  const expired = normalizePlatformSession(defaultPlatformSession(), {
    status: "LOGIN_REQUIRED",
    route: "#/login",
    reason: "省平台显示登录页面"
  }, "2026-07-19T10:00:00.000Z");
  assert.equal(expired.status, "LOGIN_REQUIRED");
  assert.equal(expired.recoveryRequired, true);
  assert.deepEqual(expired.recoveryPendingSources, ["realtime-alarms", "technical-alarms"]);
  assert.match(platformSessionBlocker(expired, "LIVE"), /真实动作已暂停/);
  assert.equal(platformSessionBlocker(expired, "DRY_RUN"), null);
});

test("重新登录后必须依次补采实时报警和技术检测", () => {
  let session = normalizePlatformSession(defaultPlatformSession(), { status: "LOGIN_REQUIRED", route: "#/login" });
  session = normalizePlatformSession(session, { status: "AUTHENTICATED", route: "#/alarm-center/alarm-preprocessing" });
  assert.equal(session.recoveryRequired, true);
  session = platformSessionFromCapture(session, { ok: true, status: 200, url: "https://api.hnznjg.cn:7443/alarm", route: "#/alarm-center/alarm-preprocessing", matchedRule: "realtime-alarms" });
  assert.deepEqual(session.recoveryPendingSources, ["technical-alarms"]);
  session = platformSessionFromCapture(session, { ok: true, status: 200, url: "https://api.hnznjg.cn:7443/alarm", route: "#/alarm-center/alarm-preprocessing", matchedRule: "technical-alarms" });
  assert.equal(session.recoveryRequired, false);
  assert.equal(platformSessionBlocker(session, "LIVE"), null);
});

test("401和403均立即标记省平台登录失效", () => {
  for (const status of [401, 403]) {
    const session = platformSessionFromCapture(defaultPlatformSession(), { status, url: "https://api.hnznjg.cn:7443/alarm", route: "#/alarm-center/alarm-preprocessing" });
    assert.equal(session.status, "LOGIN_REQUIRED");
    assert.match(session.reason, new RegExp(String(status)));
  }
});

test("本机沙箱401不会污染真实省平台登录状态", () => {
  const authenticated = normalizePlatformSession(defaultPlatformSession(), { status: "AUTHENTICATED", route: "#/alarm-center/alarm-preprocessing" });
  const session = platformSessionFromCapture(authenticated, { status: 401, url: "http://127.0.0.1:18080/api/alarm", route: "#/login" });
  assert.equal(session.status, "AUTHENTICATED");
  assert.equal(session.recoveryRequired, false);
});

test("会话审计路由会移除查询参数和长标识", () => {
  const session = normalizePlatformSession(defaultPlatformSession(), {
    status: "LOGIN_REQUIRED",
    route: "#/alarm-center/detail/1234567890123456789?token=synthetic-secret"
  });
  assert.equal(session.route, "#/alarm-center/detail/:id");
  assert.doesNotMatch(session.route, /token|synthetic-secret/);
});

test("省平台上下文只保留脱敏摘要并默认保持未核验", () => {
  const session = normalizePlatformSession(defaultPlatformSession(), {
    status: "AUTHENTICATED",
    route: "#/vehicle-monitor/real-time",
    platformDisplayName: "省平台值班员",
    platformIdentityStatus: "UNVERIFIED",
    platformVisibleScopeHash: "A".repeat(64),
    platformPermissionSummary: { routeRealTime: true, hasAlarmNavigation: true, ignored: { raw: "page" } },
    platformIdentityObservedAt: "2026-07-21T00:00:00.000Z"
  });
  assert.equal(session.platformDisplayName, "省平台值班员");
  assert.equal(session.platformIdentityStatus, "UNVERIFIED");
  assert.equal(session.platformVisibleScopeHash, "a".repeat(64));
  assert.deepEqual(session.platformPermissionSummary, { routeRealTime: true, hasAlarmNavigation: true });
  assert.equal(platformSessionBlocker(session, "LIVE"), null);
  const unknown = normalizePlatformSession(session, { status: "AUTHENTICATED", route: "#/" });
  assert.equal(unknown.platformIdentityStatus, "UNVERIFIED");
});
