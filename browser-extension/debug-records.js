(() => {
  function createStore(limit = 20) {
    let records = [];
    return {
      add(record) {
        records = [record, ...records.filter((item) => item.captureId !== record.captureId)].slice(0, limit);
      },
      get(captureId) {
        return records.find((record) => record.captureId === captureId) || null;
      },
      list() {
        return [...records];
      }
    };
  }

  globalThis.HnCollectorDebug = {
    createStore,
    formatRecord(record) {
      return JSON.stringify(record, null, 2);
    }
  };
})();
