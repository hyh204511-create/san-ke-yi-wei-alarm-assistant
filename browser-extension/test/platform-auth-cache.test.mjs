import test from "node:test";
import assert from "node:assert/strict";

import { createPlatformAuthCache } from "../platform-auth-cache.js";

test("平台Bearer只在当前标签内存中短期保留且从不接受其他来源", () => {
  let clock = 1000;
  const cache = createPlatformAuthCache({ maxAgeMs: 2000, now: () => clock });
  const authorization = "Bearer test-token-value";
  assert.equal(cache.observe({
    tabId: 7,
    url: "https://hn.hnznjg.cn:7443/api/alarm-service/alarm/query",
    requestHeaders: [{ name: "Authorization", value: authorization }],
  }), true);
  assert.equal(cache.get(7, "https://hn.hnznjg.cn:7443/#/vehicle-monitor/real-time"), authorization);
  assert.equal(cache.get(8, "https://hn.hnznjg.cn:7443/#/vehicle-monitor/real-time"), null);
  assert.equal(cache.get(7, "not-a-url"), null);
  assert.equal(cache.observe({
    tabId: 8,
    url: "https://example.com/api/alarm",
    requestHeaders: [{ name: "Authorization", value: authorization }],
  }), false);
  clock = 4001;
  assert.equal(cache.get(7, "https://hn.hnznjg.cn:7443/#/vehicle-monitor/real-time"), null);
});
