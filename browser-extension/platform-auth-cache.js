const PLATFORM_HOST = /(^|\.)hnznjg\.cn$/i;

function isPlatformApiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.port === "7443"
      && PLATFORM_HOST.test(url.hostname)
      && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function bearerFromHeaders(headers) {
  const header = (Array.isArray(headers) ? headers : []).find(
    (item) => String(item?.name || "").toLowerCase() === "authorization"
  );
  const value = String(header?.value || "").trim();
  return /^Bearer \S{8,4080}$/.test(value) ? value : null;
}

export function createPlatformAuthCache({ maxAgeMs = 120_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return Object.freeze({
    observe(details) {
      const tabId = Number(details?.tabId);
      const authorization = bearerFromHeaders(details?.requestHeaders);
      if (!Number.isInteger(tabId) || tabId < 0 || !isPlatformApiUrl(details?.url) || !authorization) return false;
      entries.set(tabId, { authorization, observedAt: now() });
      return true;
    },
    get(tabId, currentUrl) {
      const entry = entries.get(Number(tabId));
      let currentOriginApi = "";
      try { currentOriginApi = `${new URL(currentUrl).origin}/api/session-check`; } catch { return null; }
      if (!entry || !isPlatformApiUrl(currentOriginApi)) return null;
      if (now() - entry.observedAt > maxAgeMs) {
        entries.delete(Number(tabId));
        return null;
      }
      return entry.authorization;
    },
    delete(tabId) {
      entries.delete(Number(tabId));
    },
  });
}

export { bearerFromHeaders, isPlatformApiUrl };
