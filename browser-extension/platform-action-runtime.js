(() => {
  const ENDPOINTS = Object.freeze({
    voiceStart: "/api/schedule-service/sendVideo/sendRealAudioTransmissionMessage",
    voiceKeepalive: "/api/gpsp-service/sendVideo/sendRealAudioKeepMessage",
    voiceStop: "/api/schedule-service/sendVideo/sendRealAudioControlMessage",
    textSend: "/api/gpsp-service/sendCar/sendCarMessage",
    markProcessed: "/api/alarm-service/alarm/center/positiveAlarm",
  });
  const SPEEDING_TEXT = "驾驶员，平台已报警，车辆超速驾驶，请降速安全行驶。";

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function normalizedPlate(value) {
    return cleanText(value).replace(/[（(][^)）]*[)）]/g, "").replace(/\s+/g, "").toUpperCase();
  }

  function validEvent(event) {
    return Boolean(
      event
      && /^\d{10,30}$/.test(String(event.alarmId || ""))
      && String(event.sourceKind || "") === "PREWARNING"
      && cleanText(event.alarmName) === "超速驾驶"
      && String(event.vehicleId || "").length > 0
      && String(event.vehicleId || "").length <= 160
      && normalizedPlate(event.vehicleNo)
      && String(event.certColor || "").length > 0
      && String(event.certColor || "").length <= 20
    );
  }

  function speedingRow(documentRef, event) {
    const rows = [...documentRef.querySelectorAll("tr.ve-table-body-tr[row-key]")];
    const row = rows.find((item) => item.getAttribute("row-key") === String(event.alarmId));
    if (!row) return null;
    const cells = [...row.querySelectorAll("td")].map((item) => cleanText(item.textContent));
    if (normalizedPlate(cells[1]) !== normalizedPlate(event.vehicleNo)) return null;
    if (cells[2] !== "超速驾驶") return null;
    if (event.alarmTime && cells[3] && cells[3] !== cleanText(event.alarmTime)) return null;
    return row;
  }

  function hasActionButtons(root) {
    const labels = [...root.querySelectorAll("button")].map((item) => cleanText(item.textContent));
    return labels.includes("语音对讲") && labels.includes("文本下发");
  }

  function monitorShowsVehicle(documentRef, vehicleNo) {
    const plate = normalizedPlate(vehicleNo);
    const nodes = [...documentRef.querySelectorAll("p,span,div")].filter((node) => {
      if (node.closest("tr")) return false;
      return normalizedPlate(node.textContent) === plate;
    });
    for (const node of nodes) {
      let root = node;
      for (let depth = 0; root && depth < 9; depth += 1, root = root.parentElement) {
        if (hasActionButtons(root)) return true;
      }
    }
    return false;
  }

  async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 100, sleepImpl } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await sleepImpl(intervalMs);
    }
    return false;
  }

  async function prepareVehicle(documentRef, event, sleepImpl) {
    const row = speedingRow(documentRef, event);
    if (!row) return { status: "BLOCKED", errorCode: "ALARM_ROW_NOT_FOUND" };
    if (!monitorShowsVehicle(documentRef, event.vehicleNo)) row.click();
    const selected = await waitFor(
      () => monitorShowsVehicle(documentRef, event.vehicleNo),
      { sleepImpl }
    );
    return selected
      ? { status: "SUCCEEDED" }
      : { status: "BLOCKED", errorCode: "MONITOR_VEHICLE_MISMATCH" };
  }

  function authHeaders(authorization) {
    const value = cleanText(authorization);
    if (!/^Bearer \S{8,4080}$/.test(value)) return null;
    return {
      "content-type": "application/json",
      authorization: value,
    };
  }

  async function postJson(path, body, context, timeoutMs = 8000) {
    if (!Object.values(ENDPOINTS).includes(path)) {
      return { status: "BLOCKED", errorCode: "ENDPOINT_NOT_ALLOWED" };
    }
    const headers = authHeaders(context.authorization);
    if (!headers) return { status: "BLOCKED", errorCode: "PLATFORM_TOKEN_MISSING" };
    const controller = new context.AbortControllerImpl();
    const timeout = context.setTimeoutImpl(() => controller.abort(), timeoutMs);
    try {
      const response = await context.fetchImpl(path, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!payload) return { status: "UNKNOWN", errorCode: "PLATFORM_RESPONSE_UNKNOWN", platformHttpStatus: response.status };
      if (!response.ok || payload.success === false || payload.errCode) {
        return {
          status: "FAILED",
          errorCode: cleanText(payload.errCode || payload.code || "PLATFORM_REJECTED").slice(0, 80),
          platformHttpStatus: response.status,
          payload,
        };
      }
      return { status: "SUCCEEDED", platformHttpStatus: response.status, payload };
    } catch (error) {
      return {
        // A transport failure does not prove that the platform rejected the
        // request. The server may have applied the side effect before the
        // response was lost, so every fetch exception must stop the plan.
        status: "UNKNOWN",
        errorCode: error?.name === "AbortError" ? "PLATFORM_REQUEST_TIMEOUT" : "PLATFORM_REQUEST_FAILED",
      };
    } finally {
      context.clearTimeoutImpl(timeout);
    }
  }

  function decodeBase64(base64) {
    const binary = atob(String(base64 || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function openSocket(url, context, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let settled = false;
      let socket;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        context.clearTimeoutImpl(timeout);
        resolve(result);
      };
      const timeout = context.setTimeoutImpl(
        () => finish({ status: "UNKNOWN", errorCode: "VOICE_SOCKET_TIMEOUT", socket }),
        timeoutMs
      );
      try {
        socket = new context.WebSocketImpl(url);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => finish({ status: "SUCCEEDED", socket });
        socket.onerror = () => finish({ status: "FAILED", errorCode: "VOICE_SOCKET_REJECTED", socket });
        socket.onclose = () => finish({ status: "UNKNOWN", errorCode: "VOICE_SOCKET_CLOSED", socket });
      } catch {
        finish({ status: "FAILED", errorCode: "VOICE_SOCKET_CREATE_FAILED", socket: null });
      }
    });
  }

  async function executeVoice(request, context) {
    let pcm;
    try {
      pcm = decodeBase64(request.pcmBase64);
    } catch {
      return { status: "BLOCKED", errorCode: "VOICE_ASSET_INVALID" };
    }
    if (!pcm.length || pcm.length % 2 !== 0 || pcm.length > 320000) {
      return { status: "BLOCKED", errorCode: "VOICE_ASSET_INVALID" };
    }
    const startedAt = Date.now();
    const start = await postJson(ENDPOINTS.voiceStart, {
      cameraIds: [1],
      carId: request.event.vehicleId,
      streamType: 0,
      subCode: 2,
    }, context);
    const stream = start.payload?.data?.[0];
    if (start.status !== "SUCCEEDED") return start;
    if (!stream?.httpUrl || !stream?.fileName || stream.errDesc) {
      return {
        status: stream?.errDesc ? "FAILED" : "UNKNOWN",
        errorCode: cleanText(stream?.errDesc || "VOICE_START_RESPONSE_UNKNOWN").slice(0, 80),
      };
    }
    const opened = await openSocket(stream.httpUrl, context);
    if (opened.status !== "SUCCEEDED") {
      try { opened.socket?.close?.(); } catch {}
      await postJson(ENDPOINTS.voiceStop, {
        cameraIds: [1], carId: request.event.vehicleId, subCode: 4, reason: 0,
        streamType: 0, closeType: 0, filename: stream.fileName,
      }, context);
      return { ...opened, status: "UNKNOWN", errorCode: "VOICE_START_RESULT_UNKNOWN" };
    }
    const socket = opened.socket;
    let bytesSent = 0;
    let keepaliveAt = Date.now() + 5000;
    let streamFailure = null;
    try {
      for (let offset = 0; offset < pcm.length; offset += 640) {
        if (socket.readyState !== 1) {
          streamFailure = { status: "UNKNOWN", errorCode: "VOICE_SOCKET_INTERRUPTED", bytesSent };
          break;
        }
        const chunk = pcm.slice(offset, Math.min(offset + 640, pcm.length));
        socket.send(chunk.buffer);
        bytesSent += chunk.byteLength;
        if (Date.now() >= keepaliveAt) {
          const keepalive = await postJson(ENDPOINTS.voiceKeepalive, {
            carId: request.event.vehicleId,
            filename: stream.fileName,
            streamType: "0",
            subCode: "0",
            reason: "0",
            result: 1,
          }, context);
          if (keepalive.status !== "SUCCEEDED") {
            streamFailure = { ...keepalive, status: "UNKNOWN", errorCode: "VOICE_KEEPALIVE_UNKNOWN", bytesSent };
            break;
          }
          keepaliveAt = Date.now() + 5000;
        }
        await context.sleepImpl(40);
      }
    } catch {
      streamFailure = { status: "UNKNOWN", errorCode: "VOICE_STREAM_UNKNOWN", bytesSent };
    } finally {
      try { socket.close(); } catch {}
    }
    const stop = await postJson(ENDPOINTS.voiceStop, {
      cameraIds: [1],
      carId: request.event.vehicleId,
      subCode: 4,
      reason: 0,
      streamType: 0,
      closeType: 0,
      filename: stream.fileName,
    }, context);
    if (stop.status !== "SUCCEEDED") {
      return { ...stop, status: "UNKNOWN", errorCode: "VOICE_STOP_UNKNOWN", bytesSent };
    }
    if (streamFailure) return streamFailure;
    return {
      status: "SUCCEEDED",
      receiptRef: request.actionId,
      playbackStarted: true,
      bytesSent,
      durationMs: Date.now() - startedAt,
      platformHttpStatus: stop.platformHttpStatus,
    };
  }

  async function executeText(request, context) {
    if (cleanText(request.renderedText) !== SPEEDING_TEXT) {
      return { status: "BLOCKED", errorCode: "TEXT_ASSET_MISMATCH" };
    }
    const sent = await postJson(ENDPOINTS.textSend, {
      msgContent: SPEEDING_TEXT,
      carInfoList: [{
        carId: request.event.vehicleId,
        certColor: request.event.certColor,
        certId: normalizedPlate(request.event.vehicleNo),
        alarmTime: request.event.alarmTime,
        id: request.event.alarmId,
      }],
      adscreen: "0",
      disPlayer: "0",
      tts: "1",
      urgency: "0",
      subCode: "0",
    }, context);
    if (sent.status !== "SUCCEEDED") return sent;
    const processed = await postJson(ENDPOINTS.markProcessed, {
      id: request.event.alarmId,
      alarmTime: request.event.alarmTime,
      positiveMethod: 1,
      appealContent: SPEEDING_TEXT,
    }, context);
    if (processed.status !== "SUCCEEDED") {
      return { ...processed, status: "UNKNOWN", errorCode: "PROCESSING_MARK_UNKNOWN", terminalTts: true };
    }
    return {
      status: "SUCCEEDED",
      receiptRef: request.actionId,
      terminalTts: true,
      platformHttpStatus: processed.platformHttpStatus,
    };
  }

  async function execute(request, dependencies = {}) {
    const context = {
      documentRef: dependencies.documentRef || document,
      locationRef: dependencies.locationRef || location,
      authorization: request?.authorization,
      fetchImpl: dependencies.fetchImpl || fetch,
      WebSocketImpl: dependencies.WebSocketImpl || globalThis.WebSocket,
      AbortControllerImpl: dependencies.AbortControllerImpl || AbortController,
      setTimeoutImpl: dependencies.setTimeoutImpl || setTimeout,
      clearTimeoutImpl: dependencies.clearTimeoutImpl || clearTimeout,
      sleepImpl: dependencies.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
    if (!/^#\/vehicle-monitor\/real-time(?:$|[/?])/i.test(context.locationRef.hash || "")) {
      return { status: "BLOCKED", errorCode: "PLATFORM_ROUTE_MISMATCH" };
    }
    if (!validEvent(request?.event)) return { status: "BLOCKED", errorCode: "EVENT_NOT_AUTHORIZED" };
    const prepared = await prepareVehicle(context.documentRef, request.event, context.sleepImpl);
    if (prepared.status !== "SUCCEEDED") return prepared;
    if (request.operation === "VOICE") return executeVoice(request, context);
    if (request.operation === "TEXT") return executeText(request, context);
    return { status: "BLOCKED", errorCode: "OPERATION_NOT_ALLOWED" };
  }

  globalThis.HnPlatformActionRuntime = Object.freeze({
    ENDPOINTS,
    SPEEDING_TEXT,
    execute,
    normalizedPlate,
    validEvent,
  });
})();
