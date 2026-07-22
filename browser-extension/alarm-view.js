(() => {
  const FORMAL_ALARM_KINDS = new Set(["REALTIME", "PENDING"]);

  function isFormalAlarm(event) {
    return FORMAL_ALARM_KINDS.has(event?.sourceKind);
  }

  function countsFor(items) {
    const events = Array.isArray(items) ? items : [];
    return {
      FORMAL: events.filter((item) => isFormalAlarm(item?.event)).length,
      TECHNICAL: events.filter((item) => item?.event?.sourceKind === "TECHNICAL").length,
      PREWARNING: events.filter((item) => item?.event?.sourceKind === "PREWARNING").length
    };
  }

  function filterEvents(items, view) {
    const events = Array.isArray(items) ? items : [];
    if (view === "priority") return events.filter((item) => isFormalAlarm(item?.event) || item?.event?.sourceKind === "TECHNICAL");
    if (view === "FORMAL") return events.filter((item) => isFormalAlarm(item?.event));
    if (view === "all") return events;
    return events.filter((item) => item?.event?.sourceKind === view);
  }

  function displaySourceLabel(event) {
    return isFormalAlarm(event) ? "正式报警" : event?.sourceLabel || "其他来源";
  }

  globalThis.HnAlarmView = Object.freeze({ countsFor, displaySourceLabel, filterEvents, isFormalAlarm });
})();
