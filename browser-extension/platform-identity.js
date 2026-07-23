(() => {
  const LEGACY_SELECTORS = Object.freeze([
    ".user-name", ".username", ".userName", ".real-name", ".realName", ".account-name", ".accountName",
    "[aria-label*='当前用户']", "[title*='当前用户']", "[class*='user-name']", "[class*='username']",
    "[class*='account-name']", "[class*='realname']",
  ]);
  const CURRENT_HEADER_SELECTOR = ".navbar .right-menu .el-dropdown-link.el-dropdown-selfdefine";
  const REJECTED_TEXT = /登录|退出|设置|首页|用户中心/;

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  function acceptableName(value) {
    const text = cleanText(value);
    return text.length >= 2 && !REJECTED_TEXT.test(text) && !/^\d+$/.test(text) ? text : "";
  }

  function directText(node) {
    return cleanText(Array.from(node?.childNodes || [])
      .filter((child) => child?.nodeType === 3)
      .map((child) => child.textContent || "")
      .join(" "));
  }

  function readDisplayName(root) {
    try {
      for (const selector of LEGACY_SELECTORS) {
        const name = acceptableName(root?.querySelector?.(selector)?.textContent);
        if (name) return name;
      }
      const candidates = Array.from(root?.querySelectorAll?.(CURRENT_HEADER_SELECTOR) || [])
        .map((node) => ({ node, name: acceptableName(directText(node)) }))
        .filter(({ name }) => name)
        .map((candidate) => ({ ...candidate, rect: candidate.node.getBoundingClientRect?.() }))
        .filter(({ rect }) => rect && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < 80)
        .sort((left, right) => right.rect.right - left.rect.right);
      return candidates[0]?.name || "";
    } catch {
      return "";
    }
  }

  globalThis.HnPlatformIdentity = Object.freeze({ readDisplayName });
})();
