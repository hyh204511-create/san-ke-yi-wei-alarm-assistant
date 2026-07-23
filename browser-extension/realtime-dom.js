(() => {
  const REQUIRED_HEADERS = Object.freeze([
    "报警ID", "报警类型", "类型", "车牌号", "发生时间", "接收时间", "所属机构",
    "驾驶员", "定位速度(公里/时)", "脉冲速度(公里/时)", "报警地址",
  ]);

  function clean(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text === "-" ? "" : text;
  }

  function cleanPlate(value) {
    return clean(value).replace(/[（(][^()（）]{1,8}[)）]$/, "").trim();
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function extractRows(headers, tableRows) {
    const normalizedHeaders = (headers || []).map(clean);
    if (!REQUIRED_HEADERS.every((header) => normalizedHeaders.includes(header))) {
      return { ok: false, code: "REALTIME_DOM_HEADERS_MISMATCH", rows: [], signature: "" };
    }
    const index = Object.fromEntries(normalizedHeaders.map((header, position) => [header, position]));
    const rows = (tableRows || []).map((cells) => ({
      alarmId: clean(cells[index["报警ID"]]),
      alarmName: clean(cells[index["报警类型"]]),
      vehicleType: clean(cells[index["类型"]]),
      certId: cleanPlate(cells[index["车牌号"]]),
      alarmTime: clean(cells[index["发生时间"]]),
      receiveTime: clean(cells[index["接收时间"]]),
      companyName: clean(cells[index["所属机构"]]),
      driverName: clean(cells[index["驾驶员"]]),
      locationSpeed: clean(cells[index["定位速度(公里/时)"]]),
      pulseSpeed: clean(cells[index["脉冲速度(公里/时)"]]),
      location: clean(cells[index["报警地址"]]),
    })).filter((row) => /^\d{16,30}$/.test(row.alarmId)
      && row.alarmName && row.certId && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.alarmTime));
    const signatureMaterial = rows.map((row) => [
      row.alarmId, row.alarmName, row.certId, row.alarmTime, row.receiveTime,
      row.companyName, row.driverName, row.locationSpeed, row.pulseSpeed, row.location,
    ].join("\u001f")).join("\u001e");
    return {
      ok: true,
      code: rows.length ? "REALTIME_DOM_ROWS" : "REALTIME_DOM_EMPTY",
      rows,
      signature: rows.length ? stableHash(signatureMaterial) : "empty",
    };
  }

  globalThis.HnRealtimeDom = Object.freeze({ REQUIRED_HEADERS, extractRows });
})();
