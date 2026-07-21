export const SANDBOX_TEXT_URL = "http://127.0.0.1:18080/sandbox/api/text/simulate";

export async function executeSandboxText({ event, action }, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(SANDBOX_TEXT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alarmId: event.alarmId,
        carId: event.vehicleId,
        assetKey: action.assetKey,
        renderedText: action.renderedText,
        recipientType: action.recipientType,
        terminalTts: action.terminalTts === true,
        source: "browser-extension-sandbox-text-adapter"
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    const terminalTtsConfirmed = body?.data?.terminalTts === true;
    if (!response.ok || body?.success !== true || (action.terminalTts === true && !terminalTtsConfirmed)) {
      const failure = action.terminalTts === true && !terminalTtsConfirmed
        ? "终端TTS未收到成功回执"
        : body?.message || body?.errMessage || `文本沙箱 HTTP ${response.status}`;
      return { status: "FAILED", error: failure, result: body };
    }
    return { status: "SUCCEEDED", result: body };
  } catch (error) {
    return { status: error?.name === "AbortError" ? "UNKNOWN" : "FAILED", error: error?.name === "AbortError" ? "文本沙箱请求超时，结果未知" : String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}
