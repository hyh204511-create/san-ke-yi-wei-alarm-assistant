import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const code = await readFile(new URL("../platform-identity.js", import.meta.url), "utf8");

function loadHelper() {
  const context = { globalThis: {} };
  vm.runInNewContext(code, context);
  return context.globalThis.HnPlatformIdentity;
}

function candidate(text, { right, top = 19, width = 44, height = 15 } = {}) {
  return {
    childNodes: [{ nodeType: 1, textContent: "icon" }, { nodeType: 3, textContent: text }],
    getBoundingClientRect: () => ({ right, top, width, height }),
  };
}

test("reads the current platform identity from the rightmost visible header dropdown", () => {
  const helper = loadHelper();
  const notice = candidate("4", { right: 1394 });
  const identity = candidate("省平台值班员", { right: 1520 });
  const root = {
    querySelector: () => null,
    querySelectorAll: () => [notice, identity],
  };
  assert.equal(helper.readDisplayName(root), "省平台值班员");
});

test("keeps legacy selectors and rejects menu labels or hidden candidates", () => {
  const helper = loadHelper();
  assert.equal(helper.readDisplayName({
    querySelector: (selector) => selector === ".username" ? { textContent: "旧版值班员" } : null,
    querySelectorAll: () => [],
  }), "旧版值班员");
  assert.equal(helper.readDisplayName({
    querySelector: () => null,
    querySelectorAll: () => [candidate("设置", { right: 1520 }), candidate("候选姓名", { right: 1510, width: 0 })],
  }), "");
});

test("content loads the identity helper before the main content script", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const scripts = manifest.content_scripts.find((entry) => entry.js.includes("content.js")).js;
  assert.ok(scripts.indexOf("platform-identity.js") < scripts.indexOf("content.js"));
});
