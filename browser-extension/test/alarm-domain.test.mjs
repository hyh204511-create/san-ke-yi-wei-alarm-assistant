import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  alarmEventTime,
  alarmSourcePriority,
  compareAlarmOrder,
  createActionAttempt,
  createResponsePlan,
  enterpriseAccessForEvent,
  evaluateCompletion,
  evaluateRules,
  extractAlarmCandidates,
  mergeAlarmEvents,
  maskLedgerRow,
  normalizeAlarmRow,
  rowsToCsv,
  selectLatestEligibleSpeedingPrewarning,
  validateAudioAsset,
  validateRuntimeRuleSet,
  validateRuleSet
} from "../alarm-domain.js";

function publishedSpeedingRuleSet() {
  return {
    schemaVersion: 2,
    version: "published-speeding-v1",
    status: "PUBLISHED",
    rules: [{
      id: "automatic-speeding-prewarning",
      enabled: true,
      priority: 100,
      match: { sourceKinds: ["PREWARNING"], alarmNames: ["超速驾驶"] },
      handlingMode: "AUTO",
      allowRealIntercom: true,
      channels: [
        { type: "VOICE", order: 1, recipientType: "DRIVER", assetId: "voice-speeding-v1", spokenTemplate: "驾驶员，平台已报警，车辆超速驾驶，请降速安全行驶。" },
        { type: "TEXT", order: 2, recipientType: "DRIVER", templateId: "text-speeding-v1", terminalTts: true },
      ],
      channelStrategy: "SEQUENTIAL",
      retryPolicy: { maxRetries: 2, delaysMs: [5000, 10000], retryOn: ["FAILED"], maxDurationMs: 30000 },
      fallback: "TEXT_ON_VOICE_FAILURE",
    }],
  };
}

test("平台无时区报警时间固定按 Asia/Shanghai 解析", () => {
  assert.equal(alarmEventTime({ alarmTime: "2026-07-23 14:20:00" }), Date.parse("2026-07-23T14:20:00+08:00"));
});

test("真实自动运行只选择最新且尚未处理的超速预警", () => {
  const now = Date.parse("2026-07-23T14:20:00+08:00");
  const event = (id, alarmTime, overrides = {}) => ({
    eventId: `alarm:id:${id}`, alarmId: id, sourceKind: "PREWARNING", alarmName: "超速驾驶",
    alarmTime, vehicleId: `vehicle-${id}`, vehicleNo: `模拟${id.slice(-2)}`, certColor: "2", ...overrides,
  });
  const rows = [
    { event: event("2079948988450365401", "2026-07-23 14:14:00") },
    { event: event("2079948988450365402", "2026-07-23 14:19:00") },
    { event: event("2079948988450365403", "2026-07-23 14:19:30"), action: { status: "FAILED" } },
    { event: event("2079948988450365404", "2026-07-23 14:19:40"), processing: { status: "PROCESSED" } },
    { event: event("2079948988450365405", "2026-07-23 14:19:50", { alarmName: "疲劳驾驶" }) },
  ];
  assert.equal(selectLatestEligibleSpeedingPrewarning(rows, now)?.event.alarmId, "2079948988450365402");
});

test("真实自动运行拒绝过期、未来和缺少车辆标识的预警", () => {
  const now = Date.parse("2026-07-23T14:20:00+08:00");
  const rows = [
    { event: { eventId: "old", alarmId: "2079948988450365411", sourceKind: "PREWARNING", alarmName: "超速驾驶", alarmTime: "2026-07-23 14:00:00", vehicleId: "v1", vehicleNo: "模拟01", certColor: "2" } },
    { event: { eventId: "future", alarmId: "2079948988450365412", sourceKind: "PREWARNING", alarmName: "超速驾驶", alarmTime: "2026-07-23 14:22:00", vehicleId: "v2", vehicleNo: "模拟02", certColor: "2" } },
    { event: { eventId: "weak", alarmId: "2079948988450365413", sourceKind: "PREWARNING", alarmName: "超速驾驶", alarmTime: "2026-07-23 14:19:00", vehicleNo: "模拟03", certColor: "2" } },
  ];
  assert.equal(selectLatestEligibleSpeedingPrewarning(rows, now), null);
});

test("自动超速预报警保留PREWARNING来源并生成语音后文本计划", () => {
  const event = {
    eventId: "alarm:id:2079948988450365440",
    alarmId: "2079948988450365440",
    sourceKind: "PREWARNING",
    alarmName: "超速驾驶",
    alarmTime: "2026-07-23 00:10:00",
    vehicleId: "vehicle-test-001",
    vehicleNo: "模拟车A01",
    certColor: "2",
  };
  const decision = evaluateRules(event, publishedSpeedingRuleSet());
  assert.equal(decision.automaticPromotion, true);
  assert.equal(decision.effectiveActionKind, "AUTOMATIC_FORMAL");
  assert.deepEqual(decision.channels.map((channel) => channel.type), ["VOICE", "TEXT"]);
  const settings = { automaticRealActions: true };
  const assets = {
    "voice-speeding-v1": {
      assetKey: "voice-speeding-v1", channelType: "VOICE", version: "v1",
      contentHash: "voice-hash", voiceBase64: "AAAAAA==",
    },
    "text-speeding-v1": {
      assetKey: "text-speeding-v1", channelType: "TEXT", version: "v1",
      contentHash: "text-hash", textTemplate: "驾驶员，平台已报警，车辆超速驾驶，请降速安全行驶。",
    },
  };
  const plan = createResponsePlan(event, decision, settings, assets);
  assert.equal(plan.status, "PLANNED");
  assert.equal(plan.automaticPromotion, true);
  assert.equal(plan.attempts[0].assetHash, "voice-hash");
  assert.equal(event.sourceKind, "PREWARNING");
});

test("预报警只有明确发布且显式包含PREWARNING来源的规则才能自动执行", () => {
  const event = {
    eventId: "alarm:id:2079948988450365449", alarmId: "2079948988450365449",
    sourceKind: "PREWARNING", alarmName: "超速驾驶", vehicleId: "vehicle-9", vehicleNo: "模拟09", certColor: "2",
  };
  const published = publishedSpeedingRuleSet();
  assert.equal(evaluateRules(event, published).action, "RESPONSE_PLAN");
  assert.equal(evaluateRules(event, { ...published, status: "APPROVED" }).action, "RECORD_ONLY");
  const implicitSource = { ...published, rules: [{ ...published.rules[0], match: { alarmNames: ["超速驾驶"] } }] };
  assert.equal(evaluateRules(event, implicitSource).action, "RECORD_ONLY");
});

test("真实自动动作策略关闭时超速预报警计划保持阻断", () => {
  const event = {
    eventId: "alarm:id:2079948988450365441", alarmId: "2079948988450365441",
    sourceKind: "PREWARNING", alarmName: "超速驾驶", vehicleId: "vehicle-test-002", vehicleNo: "模拟车A02", certColor: "2",
  };
  const decision = evaluateRules(event, publishedSpeedingRuleSet());
  const plan = createResponsePlan(event, decision, { automaticRealActions: false }, {
    "voice-speeding-v1": { assetKey: "voice-speeding-v1", channelType: "VOICE", version: "v1", contentHash: "v" },
    "text-speeding-v1": { assetKey: "text-speeding-v1", channelType: "TEXT", version: "v1", contentHash: "t", textTemplate: "驾驶员，平台已报警，车辆超速驾驶，请降速安全行驶。" },
  });
  assert.equal(plan.status, "BLOCKED");
  assert.match(plan.blockers.join("；"), /真实自动动作策略未启用/);
});

const RETRY_POLICY = { maxRetries: 2, delaysMs: [5000, 10000], retryOn: ["FAILED"], maxDurationMs: 30000 };

function reminderPolicy(overrides = {}) {
  return {
    category: "DRIVER_IMMEDIATE",
    driverReminder: "VOICE_REQUIRED",
    secondaryChannelMode: "ON_PRIMARY_FAILURE",
    completion: {
      source: "PLATFORM_STATUS",
      fields: ["alarmStatus", "alarmCompleteStatus"],
      clearedValues: { alarmStatus: ["0", "CLEARED"], alarmCompleteStatus: ["6", "已解除"] },
      unknownAction: "MANUAL_REVIEW",
    },
    ...overrides,
  };
}

test("提醒策略支持语音必做、文本失败兜底和平台状态完成判定", async () => {
  const text = "驾驶员，请立即安全停车。";
  const textHash = createHash("sha256").update(`TEXT\0${text}`, "utf8").digest("hex");
  const voiceBytes = Buffer.from([0, 0, 1, 0]);
  const voiceHash = createHash("sha256").update(Buffer.concat([Buffer.from("VOICE\0"), voiceBytes])).digest("hex");
  const assets = {
    "text-fallback": { assetKey: "text-fallback", version: "v1", channelType: "TEXT", contentHash: textHash, textTemplate: text },
    "voice-primary": { assetKey: "voice-primary", version: "v1", channelType: "VOICE", contentHash: voiceHash, voiceBase64: voiceBytes.toString("base64") },
  };
  const ruleSet = {
    schemaVersion: 2, version: "reminder-v1", status: "PUBLISHED", rules: [{
      id: "emergency-voice", enabled: true, priority: 100,
      match: { alarmNames: ["驾驶员突发情况报警"], sourceKinds: ["REALTIME"] }, handlingMode: "AUTO",
      reminderPolicy: reminderPolicy(),
      channels: [
        { type: "VOICE", order: 1, assetId: "voice-primary", recipientType: "DRIVER_TERMINAL", spokenTemplate: "请立即安全停车" },
        { type: "TEXT", order: 2, templateId: "text-fallback", recipientType: "DRIVER_TERMINAL", terminalTts: true },
      ],
      channelStrategy: "FALLBACK", retryPolicy: RETRY_POLICY, fallback: "MANUAL",
    }],
  };
  assert.equal((await validateRuntimeRuleSet(ruleSet, assets)).ok, true);
  const event = { eventId: "alarm:id:1", alarmId: "1", sourceKind: "REALTIME", alarmName: "驾驶员突发情况报警", vehicleId: "car-1" };
  const decision = evaluateRules(event, ruleSet);
  assert.equal(decision.reminderPolicy.driverReminder, "VOICE_REQUIRED");
  assert.equal(decision.channelStrategy, "FALLBACK");
  const plan = createResponsePlan(event, decision, { automaticRealActions: true }, assets);
  assert.equal(plan.attempts.length, 2);
  assert.equal(plan.attempts[0].channelType, "VOICE");
  assert.equal(plan.attempts[1].type, "TEXT_TTS");
  assert.equal(evaluateCompletion({ alarmStatus: "0" }, decision.reminderPolicy).status, "PLATFORM_CLEARED");
  assert.equal(evaluateCompletion({ alarmStatus: "1" }, decision.reminderPolicy).status, "PLATFORM_ACTIVE");
  assert.equal(evaluateCompletion({}, decision.reminderPolicy).status, "UNKNOWN_MANUAL");
});

test("企业范围同时支持平台企业编码和企业名称且默认拒绝", () => {
  const scopes = [{ enterpriseId: "scope-1", enterpriseCode: "COMPANY-001", enterpriseName: "测试运输企业" }];
  assert.equal(enterpriseAccessForEvent({ companyId: "COMPANY-001" }, scopes).status, "ALLOWED");
  assert.equal(enterpriseAccessForEvent({ companyName: " 测试运输企业 " }, scopes).status, "ALLOWED");
  assert.equal(enterpriseAccessForEvent({ companyId: "COMPANY-OTHER" }, scopes).status, "OUT_OF_SCOPE");
  assert.equal(enterpriseAccessForEvent({ vehicleNo: "湘A测001" }, scopes).status, "UNRESOLVED");
  assert.equal(enterpriseAccessForEvent({ companyId: "COMPANY-001" }, []).status, "NO_SCOPE");
});

test("Schema V2支持规则选择文本加终端TTS响应计划", async () => {
  const template = "{vehicleNo} 发生 {alarmName}，请安全停车";
  const textHash = createHash("sha256").update(`TEXT\0${template}`, "utf8").digest("hex");
  const assets = {
    "text-fatigue-v1": { assetKey: "text-fatigue-v1", version: "v1", channelType: "TEXT", contentHash: textHash, textTemplate: template }
  };
  const ruleSet = {
    schemaVersion: 2, version: "rules-v2", status: "PUBLISHED", rules: [{
      id: "fatigue-plan", enabled: true, priority: 100, match: { alarmNames: ["疲劳驾驶"], sourceKinds: ["REALTIME"] }, handlingMode: "AUTO",
      channels: [
        { type: "TEXT", order: 1, templateId: "text-fatigue-v1", recipientType: "DRIVER_TERMINAL", terminalTts: true }
      ], channelStrategy: "SINGLE", retryPolicy: { maxRetries: 2, delaysMs: [5000, 10000], retryOn: ["FAILED"], maxDurationMs: 30000 }, fallback: "MANUAL"
    }]
  };
  const textOnlyValidation = await validateRuntimeRuleSet({ ...ruleSet, rules: [{ ...ruleSet.rules[0], channels: [ruleSet.rules[0].channels[0]] }] }, { "text-fatigue-v1": assets["text-fatigue-v1"] });
  assert.equal(textOnlyValidation.ok, true);
  const event = { eventId: "alarm:id:1", alarmId: "1", sourceKind: "REALTIME", alarmName: "疲劳驾驶", vehicleId: "car-1", vehicleNo: "湘A测001" };
  const decision = evaluateRules(event, ruleSet);
  assert.equal(decision.action, "RESPONSE_PLAN");
  assert.deepEqual(decision.channels.map((channel) => channel.type), ["TEXT"]);
  const plan = createResponsePlan(event, decision, { automaticRealActions: true }, assets);
  assert.equal(plan.status, "PLANNED");
  assert.equal(plan.attempts[0].renderedText, "湘A测001 发生 疲劳驾驶，请安全停车");
  assert.equal(plan.attempts[0].type, "TEXT_TTS");
  assert.equal(plan.attempts[0].terminalTts, true);
});

const capture = {
  captureId: "capture-1",
  capturedAt: "2026-07-18T01:02:03.000Z",
  matchedRule: "alarm-query",
  response: { body: { data: { records: [] } } }
};

test("标准报警保持19位ID字符串并支持嵌套分页", () => {
  const row = {
    id: "9000000000000000001",
    alarmTypeId: 62,
    alarmName: "抽烟报警",
    alarmTime: "2026-07-18 09:10:11",
    carId: "car-1",
    certId: "湘A测001"
  };
  const nested = { ...capture, response: { body: { data: { records: [row] } } } };
  assert.equal(extractAlarmCandidates(nested).length, 1);
  const event = normalizeAlarmRow(row, capture);
  assert.equal(event.alarmId, "9000000000000000001");
  assert.equal(typeof event.alarmId, "string");
  assert.equal(event.alarmTypeId, "62");
  assert.equal(event.eventId, "alarm:id:9000000000000000001");
});

test("跨接口合并保留字段来源并显式记录冲突", () => {
  const first = normalizeAlarmRow({ id: "9000000000000000001", carId: "test-car-001", certId: "湘A测001", alarmName: "抽烟报警" }, capture);
  const second = normalizeAlarmRow({ id: "9000000000000000001", carId: "test-car-001", certId: "湘A测002", companyName: "测试运输企业A" }, { ...capture, captureId: "capture-2", matchedRule: "alarm-details" });
  const merged = mergeAlarmEvents(first, second);
  assert.deepEqual(merged.conflicts.vehicleNo, ["湘A测001", "湘A测002"]);
  assert.equal(merged.companyName, "测试运输企业A");
  assert.equal(merged.sourceCaptures.length, 2);
  assert.equal(merged.conflicts.discoveredAt, undefined);
  assert.equal(merged.conflicts.updatedAt, undefined);
});

test("平台状态变化使用最新值并保留状态迁移，支持解除判定", () => {
  const first = normalizeAlarmRow(
    { id: "9000000000000000020", alarmName: "超速驾驶报警", alarmStatus: "1", alarmCompleteStatus: "ACTIVE", certId: "湘A测020" },
    { ...capture, captureId: "capture-status-1", matchedRule: "realtime-alarms", capturedAt: "2026-07-19T12:00:00Z" }
  );
  const second = normalizeAlarmRow(
    { id: "9000000000000000020", alarmName: "超速驾驶报警", alarmStatus: "0", alarmCompleteStatus: "CLEARED", certId: "湘A测020" },
    { ...capture, captureId: "capture-status-2", matchedRule: "realtime-alarms", capturedAt: "2026-07-19T12:00:05Z" }
  );
  const merged = mergeAlarmEvents(first, second);
  assert.equal(merged.alarmStatus, "0");
  assert.equal(merged.alarmCompleteStatus, "CLEARED");
  assert.equal(merged.statusTransitions[0].field, "alarmStatus");
  assert.equal(merged.statusTransitions[1].field, "alarmCompleteStatus");
});

test("重复轮询按接口聚合字段来源且事件大小保持有界", () => {
  let event = normalizeAlarmRow(
    { id: "9000000000000000010", alarmName: "疲劳驾驶报警", certId: "湘A测010", companyName: "测试企业" },
    { ...capture, captureId: "capture-0", capturedAt: "2026-07-19T00:00:00Z", matchedRule: "realtime-alarms" }
  );
  for (let index = 1; index <= 100; index += 1) {
    event = mergeAlarmEvents(event, normalizeAlarmRow(
      { id: "9000000000000000010", alarmName: "疲劳驾驶报警", certId: "湘A测010", companyName: "测试企业" },
      { ...capture, captureId: `capture-${index}`, capturedAt: `2026-07-19T00:${String(index % 60).padStart(2, "0")}:00Z`, matchedRule: "realtime-alarms" }
    ));
  }
  assert.equal(event.sourceCaptureCount, 101);
  assert.equal(event.sourceCaptures.length, 20);
  assert.equal(event.sources.vehicleNo.length, 1);
  assert.equal(event.sources.vehicleNo[0].occurrences, 101);
  assert.ok(JSON.stringify(event).length < 15000);
});

test("报警来源区分且实时报警可晋级覆盖历史查询主来源", () => {
  const history = normalizeAlarmRow(
    { id: "9000000000000000002", alarmName: "生理疲劳", alarmTime: "2026-07-19 12:20:00", certId: "湘A测002" },
    { ...capture, captureId: "capture-history", matchedRule: "alarm-query" }
  );
  const realtime = normalizeAlarmRow(
    { id: "9000000000000000002", alarmName: "生理疲劳", alarmTime: "2026-07-19 12:20:00", certId: "湘A测002" },
    { ...capture, captureId: "capture-realtime", matchedRule: "realtime-alarms" }
  );
  const merged = mergeAlarmEvents(history, realtime);
  assert.equal(history.sourceKind, "HISTORY");
  assert.equal(realtime.sourceKind, "REALTIME");
  assert.equal(merged.sourceKind, "REALTIME");
  assert.equal(merged.sourceLabel, "实时报警（正式报警）");
  assert.equal(alarmSourcePriority(merged), 4);
  assert.deepEqual(merged.sourceEndpoints, ["alarm-query", "realtime-alarms"]);

  const technical = normalizeAlarmRow(
    { id: "9000000000000000003", alarmName: "设备异常", alarmTime: "2026-07-19 12:21:00", certId: "湘A测003" },
    { ...capture, captureId: "capture-technical", matchedRule: "technical-alarms" }
  );
  assert.equal(technical.sourceKind, "TECHNICAL");
  assert.ok(alarmSourcePriority(realtime) > alarmSourcePriority(technical));
  assert.ok(alarmSourcePriority(technical) > alarmSourcePriority(history));
  assert.ok(compareAlarmOrder(
    { priority: alarmSourcePriority(realtime), time: Date.parse(realtime.alarmTime) },
    { priority: alarmSourcePriority(technical), time: Date.parse(technical.alarmTime) }
  ) < 0);

  const pending = normalizeAlarmRow(
    { id: "9000000000000000004", alarmName: "待处理报警", alarmTime: "2026-07-19 12:22:00", certId: "湘A测004" },
    { ...capture, captureId: "capture-pending", matchedRule: "pending-alarms" }
  );
  const prewarning = normalizeAlarmRow(
    { id: "9000000000000000005", alarmName: "超速预警", alarmTime: "2026-07-19 12:23:00", certId: "湘A测005" },
    { ...capture, captureId: "capture-prewarning", matchedRule: "prewarning-query" }
  );
  assert.equal(pending.sourceKind, "PENDING");
  assert.equal(pending.sourceLabel, "待处理正式报警");
  assert.equal(prewarning.sourceKind, "PREWARNING");
  assert.equal(prewarning.sourceLabel, "预报警（实时抓取）");
  assert.equal(evaluateRules(pending, { schemaVersion: 1, version: "test", rules: [] }).action, "MANUAL_REVIEW");
  assert.equal(evaluateRules(prewarning, { schemaVersion: 1, version: "test", rules: [] }).action, "RECORD_ONLY");
});

test("真实平台报警字段契约被完整标准化且查询历史只记录", () => {
  const history = normalizeAlarmRow({
    id: "9000000000000000009", alarmId: "62", alarmTypeId: "62", alarmName: "疲劳驾驶报警",
    alarmTime: "2026-07-19 12:20:00", carId: "test-car-009", certId: "湘A测009",
    companyId: "COMPANY-009", companyName: "测试企业", driverName: "测试司机",
    posDesc: "测试位置", locationSpeed: 52, pulseSpeed: 50, alarmStatus: 2,
    alarmCompleteStatus: 6, alarmCompleteStatusName: "申诉审核", dealFlag: "0",
    dispositionFlag: "1", ignoreStatus: "0", verificationStatus: "0",
    evidenceAuditStatus: 0, appealResult: "1", positiveReportingFLag: 0,
  }, { ...capture, matchedRule: "alarm-query" });
  assert.equal(history.sourceKind, "HISTORY");
  assert.equal(history.location, "测试位置");
  assert.equal(history.platformStatus, "申诉审核");
  assert.equal(history.alarmStatus, "2");
  assert.equal(history.alarmCompleteStatus, "6");
  assert.equal(history.dispositionFlag, "1");
  assert.equal(history.positiveReportingFlag, "0");
  assert.equal(evaluateRules(history, { schemaVersion: 1, version: "test", rules: [] }).action, "RECORD_ONLY");
});

test("技术检测保留诊断字段并在后续抓取中合并更新", () => {
  const first = normalizeAlarmRow({
    id: "9000000000000000090", alarmId: "9000000000000000090", alarmName: "设备异常",
    alarmTime: "2026-07-19 12:40:00", alarmTimeEnd: "2026-07-19 12:45:00", certId: "TEST-090",
    detail: "设备离线", sysType: "视频监控", statusName: "待处理", recorderSpeed: 0,
    traceno: "trace-090", contactInformation: "synthetic-contact", driverNumber: "synthetic-driver"
  }, { ...capture, matchedRule: "technical-alarms", captureId: "technical-1" });
  assert.deepEqual(first.technicalDetails, {
    alarmTimeEnd: "2026-07-19 12:45:00",
    detail: "设备离线",
    sysType: "视频监控",
    statusName: "待处理",
    recorderSpeed: 0,
    traceno: "trace-090"
  });
  assert.equal(first.technicalDetails.contactInformation, undefined);
  assert.equal(first.technicalDetails.driverNumber, undefined);

  const second = normalizeAlarmRow({
    id: "9000000000000000090", detail: "视频存储故障", firmwareVersion: "synthetic-fw"
  }, { ...capture, matchedRule: "technical-alarms", captureId: "technical-2" });
  const merged = mergeAlarmEvents(first, second);
  assert.equal(merged.technicalDetails.detail, "视频存储故障");
  assert.equal(merged.technicalDetails.firmwareVersion, "synthetic-fw");
  assert.equal(merged.technicalDetails.sysType, "视频监控");
});

test("真实平台缺少文字地址时使用火星坐标作为位置兜底", () => {
  const event = normalizeAlarmRow({
    id: "9000000000000000011", alarmName: "疲劳驾驶报警", certId: "湘A测011",
    alarmTime: "2026-07-19 12:30:00", marsLat: 28.1234567, marsLon: 112.7654321,
  }, { ...capture, matchedRule: "realtime-alarms" });
  assert.equal(event.location, "坐标 28.123457,112.765432");
});

test("规则按报警ID优先匹配，冲突和未命中转人工", () => {
  const event = normalizeAlarmRow(
    { id: "9000000000000000001", alarmTypeId: "62", alarmName: "抽烟报警", carId: "test-car-001" },
    { ...capture, matchedRule: "realtime-alarms" }
  );
  const baseRule = {
    enabled: true,
    approvalStatus: "CONFIRMED",
    priority: 10,
    action: "RECORD_ONLY",
    match: { alarmNames: ["抽烟报警"] }
  };
  const ruleSet = { version: "v1", rules: [baseRule, { ...baseRule, id: "exact", action: "MANUAL_REVIEW", match: { alarmTypeIds: ["62"] } }] };
  assert.equal(evaluateRules(event, ruleSet).ruleId, "exact");

  const conflict = { version: "v2", rules: [{ ...baseRule, id: "a" }, { ...baseRule, id: "b" }] };
  assert.equal(evaluateRules(event, conflict).action, "MANUAL_REVIEW");
  assert.match(evaluateRules(event, conflict).reason, /规则冲突/);
  assert.equal(evaluateRules(event, { version: "v3", rules: [] }).action, "MANUAL_REVIEW");
});

test("正式报警、技术检测和待处理正式报警可进入规则，预报警和历史只记录", () => {
  const confirmedRuleSet = {
    version: "source-policy-v1",
    rules: [{
      id: "voice-smoking",
      enabled: true,
      approvalStatus: "CONFIRMED",
      priority: 10,
      action: "AUTO_VOICE",
      match: { alarmNames: ["抽烟报警"] },
      voiceTemplateId: "voice-smoking-v1",
      audioAssetId: "audio-smoking-v1"
    }]
  };
  const makeEvent = (matchedRule, suffix) => normalizeAlarmRow(
    { id: `900000000000000000${suffix}`, alarmName: "抽烟报警", carId: `car-${suffix}` },
    { ...capture, captureId: `capture-${matchedRule}`, matchedRule }
  );
  assert.equal(evaluateRules(makeEvent("realtime-alarms", 4), confirmedRuleSet).action, "AUTO_VOICE");
  assert.equal(evaluateRules(makeEvent("technical-alarms", 3), confirmedRuleSet).action, "AUTO_VOICE");
  assert.equal(evaluateRules(makeEvent("pending-alarms", 5), confirmedRuleSet).action, "AUTO_VOICE");
  assert.equal(evaluateRules(makeEvent("prewarning-query", 6), confirmedRuleSet).action, "RECORD_ONLY");
  assert.equal(evaluateRules(makeEvent("alarm-query", 2), confirmedRuleSet).action, "RECORD_ONLY");
  assert.equal(evaluateRules(makeEvent("alarm-details", 1), confirmedRuleSet).action, "RECORD_ONLY");
});

test("真实对讲必须同时通过规则、音频和接口验证", () => {
  const event = normalizeAlarmRow({ id: "9000000000000000001", alarmTypeId: "62", carId: "test-car-001" }, capture);
  const decision = {
    decisionId: "decision-1",
    action: "AUTO_VOICE",
    allowRealIntercom: true,
    requireVehicleAllowlist: true,
    audioAssetId: "audio-1"
  };
  const asset = { confirmed: true, sha256: "abc" };
  const blocked = createActionAttempt(event, decision, { intercom: { verified: false } }, asset);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.blockers.length, 1);
  const planned = createActionAttempt(event, decision, { intercom: { verified: true } }, asset);
  assert.equal(planned.status, "PLANNED");
  const incompleteEvent = normalizeAlarmRow({ id: "9000000000000000011", alarmTypeId: "62" }, capture);
  const incomplete = createActionAttempt(incompleteEvent, decision, { intercom: { verified: true } }, asset);
  assert.equal(incomplete.status, "BLOCKED");
  assert.match(incomplete.blockers.join("；"), /车辆标识/);
});

test("规则导入校验音频引用且CSV可由Excel打开", () => {
  const invalid = validateRuleSet({ schemaVersion: 1, version: "v1", rules: [{ id: "voice", enabled: true, approvalStatus: "CONFIRMED", priority: 1, match: { alarmTypeIds: ["62"] }, action: "AUTO_VOICE", voiceTemplateId: "t1", audioAssetId: "missing" }] }, {});
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(" "), /音频不存在/);
  const csv = rowsToCsv([{ alarmId: "9000000000000000001", note: "包含,逗号" }]);
  assert.equal(csv.startsWith("\ufeff"), true);
  assert.match(csv, /"9000000000000000001"/);
  const masked = maskLedgerRow({ alarmId: "9000000000000000001", vehicleNo: "湘A测001", driverName: "测试驾驶员甲", companyName: "测试运输企业A", location: "模拟路段A", notes: "内部备注" });
  assert.equal(masked.vehicleNo, "湘A****01");
  assert.equal(masked.driverName, "测****");
  assert.equal(masked.notes, "[值班备注已隐藏]");
});

test("规则导入拒绝格式错误、未确认音频和同优先级冲突", () => {
  const base = { id: "voice-a", enabled: true, approvalStatus: "CONFIRMED", priority: 10, match: { alarmTypeIds: ["62"], timeRanges: [{ start: "08:00", end: "18:00" }] }, action: "AUTO_VOICE", voiceTemplateId: "voice-1", audioAssetId: "audio-1", allowRealIntercom: false };
  const audioAssets = { "audio-1": { confirmed: false } };
  const ruleSet = { schemaVersion: 1, version: "v-safe", rules: [base, { ...base, id: "voice-b", action: "MANUAL_REVIEW", voiceTemplateId: null, audioAssetId: null }] };
  const validation = validateRuleSet(ruleSet, audioAssets);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("；"), /已确认音频/);
  assert.match(validation.errors.join("；"), /条件及优先级冲突/);
  const malformed = validateRuleSet({ schemaVersion: 1, version: "v-bad", rules: [{ ...base, match: { alarmTypeIds: "62", timeRanges: [{ start: "25:00", end: "18:00" }] } }] }, { "audio-1": { confirmed: true } });
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors.join("；"), /alarmTypeIds|HH:mm/);
});

test("音频资产校验PCM长度、时长和SHA-256", async () => {
  const pcm = Buffer.from([0, 0, 1, 0]);
  const valid = { id: "audio-test-v1", sampleRate: 8000, channels: 1, bitsPerSample: 16, durationMs: 0, pcmBase64: pcm.toString("base64"), sha256: createHash("sha256").update(pcm).digest("hex") };
  assert.equal((await validateAudioAsset(valid)).ok, true);
  const invalid = await validateAudioAsset({ ...valid, sha256: "0".repeat(64) });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("；"), /不一致/);
});
