import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("真实动作执行器保持在隔离内容脚本且只允许当前超速预警固定接口", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../platform-action-runtime.js", import.meta.url), "utf8");
  const pageHook = await readFile(new URL("../page-hook.js", import.meta.url), "utf8");
  const sandboxAdapter = await readFile(new URL("../sandbox-intercom.js", import.meta.url), "utf8");
  assert.equal(manifest.permissions.includes("scripting"), false);
  assert.equal(manifest.permissions.includes("webRequest"), true);
  assert.doesNotMatch(worker, /chrome\.scripting\.executeScript/);
  assert.doesNotMatch(worker, /new WebSocket/);
  assert.match(worker, /ARM_SPEEDING_PREWARNING_TEST/);
  assert.match(worker, /testPromotion/);
  for (const receiptField of ["processingStatus", "voiceStatus", "textStatus", "fallbackUsed", "bytesSent", "durationMs"]) {
    assert.match(worker, new RegExp(`"${receiptField}"`));
  }
  assert.match(runtime, /sourceKind\s*\|\|\s*""\)\s*===\s*"PREWARNING"/);
  assert.match(runtime, /alarmName\)\s*===\s*"超速驾驶"/);
  for (const endpoint of [
    "sendRealAudioTransmissionMessage",
    "sendRealAudioKeepMessage",
    "sendRealAudioControlMessage",
    "sendCarMessage",
    "positiveAlarm",
  ]) assert.match(runtime, new RegExp(endpoint));
  assert.doesNotMatch(pageHook, /sendRealAudioTransmissionMessage|sendCarMessage|positiveAlarm|new WebSocket/);
  assert.match(sandboxAdapter, /http:\/\/127\.0\.0\.1:18080\/sandbox\/api\/intercom\/simulate/);
  assert.doesNotMatch(sandboxAdapter, /hnznjg\.cn/);
});

test("省平台只执行平台授权的限定页面查询保活", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../authorized-keepalive.js", import.meta.url), "utf8");
  assert.match(content, /PLATFORM_SESSION_STATUS/);
  assert.match(content, /AUTHORIZED_KEEPALIVE_EXECUTE/);
  assert.match(worker, /platformSessionBlocker/);
  assert.match(worker, /PLATFORM_SESSION_EXPIRED/);
  assert.match(worker, /authorized-session-keepalive/);
  assert.match(worker, /platformContext/);
  assert.match(content, /platformVisibleScopeHash/);
  assert.match(content, /platformIdentityStatus/);
  assert.match(adapter, /#\/alarm-center\/alarm-preprocessing/);
  assert.match(adapter, /#\/vehicle-monitor\/real-time/);
  assert.match(adapter, /#\/alarm-center\/pr-alarm-recorde/);
  assert.match(adapter, /READ_ONLY_OBSERVE/);
  assert.match(adapter, /TARGET_AMBIGUOUS/);
  assert.doesNotMatch(adapter, /语音对讲|文本下发|查岗|申诉|忽略|正报/);
  assert.doesNotMatch(adapter, /screenX|screenY|elementFromPoint/);
  assert.match(content, /不会自动填写账号、验证码或处理人机挑战/);
});

test("扩展只为明确的本机沙箱地址增加权限", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.equal(manifest.host_permissions.includes("http://127.0.0.1:18080/*"), true);
  assert.equal(manifest.host_permissions.includes("http://localhost:18080/*"), true);
  const matches = manifest.content_scripts.flatMap((item) => item.matches);
  assert.equal(matches.includes("http://127.0.0.1:18080/*"), true);
});

test("内置规则全部保持待确认", async () => {
  const ruleSet = JSON.parse(await readFile(new URL("../default-rules.json", import.meta.url), "utf8"));
  assert.equal(ruleSet.status, "PENDING_CONFIRMATION");
  assert.equal(ruleSet.rules.every((rule) => rule.approvalStatus !== "CONFIRMED" && rule.allowRealIntercom === false), true);
});

test("设置表单编辑时不会被定时状态刷新覆盖", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(content, /let settingsDirty = false/);
  assert.match(content, /&& !settingsDirty\) renderSettings\(\)/);
  assert.match(content, /保存失败：/);
});

test("插件内容区在小窗口中保持纵向可滚动", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(content, /\.shell\{display:flex;flex-direction:column/);
  assert.match(content, /\.body\{min-height:0;overflow-y:auto/);
  assert.match(content, /\.foot\{flex:none/);
});

test("普通值班插件不提供完整JSON导出", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(content, /导出完整 JSON|export-json/);
  assert.doesNotMatch(content, /导出脱敏 CSV|export-csv/);
  assert.match(worker, /数据导出已迁移到独立报表中心/);
});

test("插件写操作必须通过实名助手权限", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  for (const permission of ["system.configure", "disposal.note", "action.retry"]) {
    assert.match(worker, new RegExp(`requireAssistantPermission\\(\\"${permission.replace(".", "\\.")}\\"`));
  }
  assert.match(worker, /credentials: "include"/);
  assert.match(content, /实名登录/);
  assert.match(content, /当前仅允许只读采集/);
  assert.match(worker, /requireShift: true/);
  assert.match(worker, /认领当前值班班次/);
  assert.match(content, /hasActiveShift/);
});

test("插件规则只能来自后台已发布版本", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(worker, /\/rules\/api\/runtime/);
  assert.match(worker, /credentials: "include"/);
  assert.doesNotMatch(worker, /message\.type === "RULES_IMPORT"/);
  assert.doesNotMatch(worker, /message\.type === "AUDIO_IMPORT"/);
  assert.doesNotMatch(content, /RULES_IMPORT|AUDIO_IMPORT|rules-file|audio-file/);
  assert.match(content, /规则治理中心/);
});

test("报警动作和人工操作必须同时通过企业范围与班次闸门", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /action\.execute/);
  assert.match(worker, /enterpriseAccessForEvent/);
  assert.match(worker, /报警企业不在当前授权范围/);
  assert.match(worker, /requireEventEnterpriseAccess/);
  assert.match(worker, /未认领当前值班班次/);
  assert.match(worker, /consumerKey/);
});

test("转人工结果同步到后台工单且写操作使用短期会话令牌", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(worker, /\/api\/action-token/);
  assert.match(worker, /x-assistant-action-token/);
  assert.match(worker, /\/disposals\/api\/cases\/upsert/);
  assert.match(worker, /DISPOSAL_MUTATE/);
  assert.match(content, /接管处置工单/);
  assert.match(content, /复核通过/);
});

test("双渠道计划保留独立结果且未知状态禁止自动切换", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const domain = await readFile(new URL("../alarm-domain.js", import.meta.url), "utf8");
  assert.match(domain, /RESPONSE_PLAN/);
  assert.match(domain, /channelStrategy/);
  assert.match(worker, /前序渠道结果未知或被安全阻断，禁止自动切换渠道/);
  assert.match(worker, /executeSandboxText/);
  assert.match(worker, /executeSandboxIntercom/);
});

test("服务端处理状态同步到插件详情且刷新不依赖单一布尔值", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(worker, /processingStatus/);
  assert.match(worker, /processingSource/);
  assert.match(worker, /processingMarkedAt/);
  assert.match(worker, /`processing:\$\{event\.eventId\}`/);
  assert.match(content, /系统处理状态/);
  assert.match(content, /处理状态来源/);
  assert.match(content, /处理状态时间/);
});

test("插件产品文案区分自动TEXT_TTS和人工语音对讲", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(content, /文本下发 \+ 终端 TTS/);
  assert.match(content, /自动语音对讲/);
  assert.match(readme, /TEXT_TTS/);
  assert.match(readme, /VOICE_INTERCOM/);
});

test("正式实时与待处理保留来源证据但在面板归为正式报警", async () => {
  const hook = await readFile(new URL("../page-hook.js", import.meta.url), "utf8");
  const domain = await readFile(new URL("../alarm-domain.js", import.meta.url), "utf8");
  const view = await readFile(new URL("../alarm-view.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(hook, /pr-alarm-recorde/);
  assert.match(hook, /prewarning-query/);
  assert.match(hook, /alarm-center-discovery/);
  assert.match(hook, /pending-alarms/);
  assert.match(domain, /kind: "PENDING", label: "待处理正式报警"/);
  assert.match(domain, /kind: "PREWARNING", label: "预报警（实时抓取）"/);
  assert.match(view, /FORMAL_ALARM_KINDS = new Set\(\["REALTIME", "PENDING"\]\)/);
  assert.match(content, /HnAlarmView/);
  assert.match(content, /data-source="FORMAL"[^>]*>正式报警/);
  assert.match(content, /alarm-center-discovery/);
  assert.doesNotMatch(content, /data-source="PENDING"/);
  assert.match(content, /实时报警/);
  assert.match(content, /待处理/);
  assert.match(content, /预报警来自省平台实时监控页的“预警列表”或“预警查询”页面/);
});

test("技术检测详情展示诊断字段而不是只显示通用报警字段", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const domain = await readFile(new URL("../alarm-domain.js", import.meta.url), "utf8");
  assert.match(domain, /TECHNICAL_DETAIL_FIELDS/);
  assert.match(domain, /technicalDetails/);
  assert.match(content, /技术检测明细/);
  assert.match(content, /技术说明/);
  assert.match(content, /系统类型/);
});

test("插件只同步报表事实而不承载日报月报导出", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(worker, /\/reports\/api\/events\/upsert/);
  assert.match(worker, /syncAlarmFact/);
  const syncBody = worker.slice(worker.indexOf("async function syncAlarmFact"), worker.indexOf("async function persistLedger"));
  assert.doesNotMatch(syncBody, /enterpriseAccessForEvent/);
  assert.match(syncBody, /reports\/api\/events\/upsert/);
  assert.doesNotMatch(content, /生成日报|生成月报|导出XLSX|导出PDF/);
  assert.match(worker, /数据导出已迁移到独立报表中心/);
});

test("extension reload invalidation is caught and surfaced for recovery", async () => {
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(content, /function runtimeSendMessage\(message\)/);
  assert.match(content, /extension context invalidated|context invalidated/i);
  assert.match(content, /return Promise\.resolve\(failed\(error\)\)/);
  assert.match(content, /扩展上下文已失效。请在扩展管理页重新加载扩展，然后刷新此省平台页面。/);

  // Keep all direct Chrome messaging inside the guarded wrapper so page
  // events cannot produce an uncaught error after an extension reload.
  assert.equal((content.match(/chrome\.runtime\.sendMessage\(message\)/g) || []).length, 1);
});
