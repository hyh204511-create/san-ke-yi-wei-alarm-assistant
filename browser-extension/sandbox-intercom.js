const SANDBOX_INTERCOM_URL = "http://127.0.0.1:18080/sandbox/api/intercom/simulate";

export async function executeSandboxIntercom({ event, action, fetchImpl = fetch, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(SANDBOX_INTERCOM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alarmId: event.alarmId,
        carId: event.vehicleId || event.vehicleNo,
        audioAssetId: action.audioAssetId,
        spokenText: action.renderedText,
        source: "browser-extension-sandbox-adapter"
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    const succeeded = response.ok && payload?.success !== false;
    return {
      status: succeeded ? "SUCCEEDED" : "FAILED",
      result: succeeded ? payload?.data || payload : null,
      error: succeeded ? null : payload?.errMessage || `沙箱对讲 HTTP ${response.status}`
    };
  } catch (error) {
    return error?.name === "AbortError"
      ? { status: "UNKNOWN", result: null, error: "沙箱语音请求超时，结果未知" }
      : { status: "FAILED", result: null, error: `沙箱对讲失败：${String(error?.message || error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

export { SANDBOX_INTERCOM_URL };
