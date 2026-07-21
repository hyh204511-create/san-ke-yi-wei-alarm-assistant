const state = { rows: [], selected: null, popupSerial: 0, scenarios: [] };

async function api(path, body = undefined) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({ success: false, errMessage: `HTTP ${response.status}` }));
  if (!response.ok || data.success === false) throw new Error(data.errMessage || `HTTP ${response.status}`);
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function loadScenario() {
  const result = await api("/sandbox/api/scenario");
  state.scenarios = result.data.scenarios;
  state.popupSerial = result.data.popupSerial;
  const select = document.querySelector("#scenarioSelect");
  select.innerHTML = state.scenarios.map((item) => `<option value="${esc(item.value)}" ${item.value === result.data.scenario ? "selected" : ""}>${esc(item.label)}</option>`).join("");
  setSandboxStatus(result.data.scenario);
}

async function loadDictionaries() {
  const [types] = await Promise.all([
    api("/api/alarm-service/alarmUserSet/listAll", {}),
    api("/api/base-service/groupinfo/loadAllVehicleGroupTree", {}),
    api("/api/base-service/vehicle/getMonitorCarBillMapInfo", {}),
    api("/api/base-service/checkPost/list", { pageNum: 1, pageSize: 10 })
  ]);
  document.querySelector("#filterAlarmType").insertAdjacentHTML("beforeend", types.data.map((item) => `<option value="${esc(item.alarmId)}">${esc(item.alarmName)}</option>`).join(""));
}

async function queryAlarms() {
  const loading = document.querySelector("#tableLoading");
  loading.classList.remove("hidden");
  try {
    const result = await api("/api/alarm-service/alarm/center/alarmQueryList", {
      pageNum: 1, pageSize: 10,
      alarmId: document.querySelector("#filterAlarmId").value.trim(),
      groupId: document.querySelector("#filterCompany").value,
      certId: document.querySelector("#filterVehicle").value.trim(),
      driverName: document.querySelector("#filterDriver").value.trim(),
      alarmTypeId: document.querySelector("#filterAlarmType").value
    });
    state.rows = result.data || result.result?.records || [];
    document.querySelector("#totalRows").textContent = result.total ?? result.result?.totalCount ?? state.rows.length;
    renderRows();
    if (state.rows[0]) selectAlarm(state.rows[0]);
  } catch (error) {
    state.rows = []; renderRows(); toast(error.message, true);
  } finally { loading.classList.add("hidden"); }
}

function renderRows() {
  const body = document.querySelector("#alarmTableBody");
  body.innerHTML = state.rows.length ? state.rows.map((row) => `<tr data-id="${esc(row.id)}"><td><span class="status-pill">${esc(row.statusName || "字段缺失")}</span></td><td title="${esc(row.id)}">${esc(row.id)}</td><td>湖南省客车车辆</td><td>${esc(row.certId)}</td><td>${esc(row.terminalVersion)}</td><td>${esc(row.driverName || "-")}</td><td>${esc(row.alarmName)}</td><td>-</td><td>${esc(row.locationSpeed)}</td><td>${esc(row.pulseSpeed)}</td><td>${esc(row.vehicleTypeName)}</td><td title="${esc(row.companyName)}">${esc(row.companyName || "-")}</td><td><button class="row-action" data-action="evidence" data-id="${esc(row.id)}">证据</button><button class="row-action" data-action="detail" data-id="${esc(row.id)}">详情</button></td></tr>`).join("") : `<tr><td colspan="13">当前场景没有可显示的报警数据</td></tr>`;
  body.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => selectAlarm(findAlarm(tr.dataset.id))));
  body.querySelectorAll("[data-action='evidence']").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); selectAlarm(findAlarm(button.dataset.id)); document.querySelector(".evidence-card").scrollIntoView({ behavior: "smooth" }); }));
  body.querySelectorAll("[data-action='detail']").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openDetail(button.dataset.id); }));
}

function findAlarm(id) { return state.rows.find((row) => String(row.id) === String(id)) || state.selected; }
function selectAlarm(row) { if (!row) return; state.selected = row; document.querySelector("#selectedAlarmLabel").textContent = `${row.certId || "未知车辆"} · ${row.alarmName || "未知报警"}`; }

async function openDetail(id) {
  try {
    const result = await api("/api/alarm-service/alarm/center/alarmDetails", { id: String(id) });
    state.selected = result.data;
    const fields = [["报警ID",result.data.id],["车牌",result.data.certId],["驾驶员",result.data.driverName],["企业",result.data.companyName],["报警类型",result.data.alarmName],["报警时间",result.data.alarmTime],["位置",result.data.location],["定位速度",`${result.data.locationSpeed ?? "-"} km/h`],["平台状态",result.data.statusName]];
    document.querySelector("#detailContent").innerHTML = fields.map(([label,value]) => `<div class="detail-field"><span>${esc(label)}</span><b>${esc(value || "-")}</b></div>`).join("") + `<div class="detail-evidence">证据组件：地图定位、驾驶员抓拍、车内视频、速度曲线 · 视频状态：${result.data.evidence?.videoAvailable ? "可用" : "不可用"}</div>`;
    document.querySelector("#detailBackdrop").classList.remove("hidden");
  } catch (error) { toast(error.message, true); }
}

async function pollRealtime() {
  try {
    const result = await api("/api/alarm-service/alarm/center/getVideoUnprocessedAlarm", {});
    const serial = result.popupSerial || 0;
    if (result.data?.length && serial > state.popupSerial) {
      state.popupSerial = serial; showAlarmPopup(result.data[0]);
    }
  } catch (error) { setSandboxStatus(error.message, true); }
}

function showAlarmPopup(row) {
  state.selected = row;
  const popup = document.querySelector("#sandbox-alarm-popup");
  for (const [field, value] of Object.entries({ vehicleNo: row.certId, alarmName: row.alarmName, alarmTime: row.alarmTime, companyName: row.companyName })) popup.querySelector(`[data-popup-field='${field}']`).textContent = value || "字段缺失";
  popup.classList.remove("hidden");
  toast(`新报警：${row.certId || "未知车辆"} ${row.alarmName || "未知类型"}`);
}

async function simulateIntercom() {
  if (!state.selected) return toast("请先选择报警", true);
  try {
    const result = await api("/sandbox/api/intercom/simulate", { alarmId: String(state.selected.id), carId: state.selected.carId, audioAssetId: "audio-sandbox-v1", source: "sandbox-page-button" });
    toast(`模拟对讲回执：${result.data.receiptId}`);
  } catch (error) { toast(error.message, true); }
}

function closeDetail() { document.querySelector("#detailBackdrop").classList.add("hidden"); }
function setSandboxStatus(message, bad = false) { const node = document.querySelector("#sandboxStatus"); node.textContent = message; node.style.color = bad ? "#ff9696" : "#87e0b8"; }
function toast(message, bad = false) { const node = document.querySelector("#toast"); node.textContent = message; node.style.background = bad ? "#a64047" : "#23384a"; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 2600); }

document.querySelector("#queryButton").addEventListener("click", queryAlarms);
document.querySelector("#exportButton").addEventListener("click", () => toast("沙箱导出按钮已触发；正式导出由值班助手面板完成"));
document.querySelector("#applyScenario").addEventListener("click", async () => { try { const name = document.querySelector("#scenarioSelect").value; await api("/sandbox/api/scenario", { scenario: name }); state.popupSerial = 0; setSandboxStatus(name); await queryAlarms(); } catch (error) { toast(error.message, true); } });
document.querySelector("#triggerAlarm").addEventListener("click", async () => { try { await api("/sandbox/api/trigger-alarm", {}); await pollRealtime(); } catch (error) { toast(error.message, true); } });
document.querySelector("#resetSandbox").addEventListener("click", async () => { await api("/sandbox/api/reset", {}); document.querySelector("#sandbox-alarm-popup").classList.add("hidden"); await loadScenario(); await queryAlarms(); });
document.querySelector("[data-close-popup]").addEventListener("click", () => document.querySelector("#sandbox-alarm-popup").classList.add("hidden"));
document.querySelector("#popupDetail").addEventListener("click", () => state.selected && openDetail(state.selected.id));
document.querySelector("#popupIntercom").addEventListener("click", simulateIntercom);
document.querySelector("#detailIntercom").addEventListener("click", simulateIntercom);
document.querySelector("#closeDetail").addEventListener("click", closeDetail);
document.querySelector("#closeDetailBottom").addEventListener("click", closeDetail);
document.querySelector("#detailBackdrop").addEventListener("click", (event) => { if (event.target.id === "detailBackdrop") closeDetail(); });

(async function boot() {
  try {
    await loadScenario();
    await loadDictionaries();
    await queryAlarms();
    await api("/api/alarm-service/alarm/center/queryAlarmUnDealCount", { alarmQueryStartTime: "2026-06-17 00:00:00", alarmQueryEndTime: "2026-06-17 23:59:59", groupId: "08" });
    await api("/api/alarm-service/alarm/center/technology/detection", {});
  } catch (error) { toast(error.message, true); }
  setInterval(pollRealtime, 3000);
})();
