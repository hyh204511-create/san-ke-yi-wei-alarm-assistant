# 三客一危省平台值班助手

## 0.5.5 权限与多页面保活更新（以本节为准）

- `SYSTEM_ADMIN` 独占报表生成、发布、导出和下载权限。
- `RULE_CONFIGURER` 只能起草、修改和提交规则；审核与发布由 `RULE_REVIEWER` 完成。
- `UNIT_USER` 为采集员，只能查看授权报警数据、读取已发布运行规则、提交设备心跳和保活审计，不能处置、执行业务动作或导出报表。
- `MONITOR_OPERATOR` 是独立的监控操作员角色，承接需要班次和动作租约的处置/沙箱动作，不得与采集员、规则配置员或规则审核员混用。
- 保活白名单覆盖三个固定页面：报警预处理页唯一“查询”按钮（允许点击）、实时监控页（只读观察）、预警列表页（只读观察）。不导航、不刷新、不点击任意业务按钮；登录页、验证码和人机挑战直接跳过并转人工。

## 0.5.4 秒级处理与提醒策略口径

- “秒级”指平台响应到达插件后，目标在 1 秒内完成本地标准化、分类、规则匹配和面板刷新；不代表每秒请求或点击省平台。
- `PREWARNING` 是平台预报警：实时捕获、立即展示和入库，但不进入优先队列、不发送司机提醒；是否升级为正式报警完全由省平台判定。
- `REALTIME`、`TECHNICAL`、`PENDING` 属于正式报警处理范围，进入优先队列并按已发布规则处理。
- 自动规则固定采用单一渠道：规则选择 `TEXT_TTS`（文本下发并启用终端TTS）或 `VOICE_INTERCOM`（自动建立语音对讲并播放固定语音）。
- 自动失败只允许明确 `FAILED` 重试，默认5秒、10秒两次；总计时达到30秒仍未明确成功就转当前值班人员处理。
- 超时、结果未知、验证码、会话失效或真实适配器未联调时记录并通知值班人员，不自动重试或切换渠道。
- `VOICE_INTERCOM` 收到成功回执后仍生成 `VOICE_REVIEW_REQUIRED`，提醒当前值班人员审核动作记录；这不代表已接通真实司机回传录音。
- 本机模拟规则可通过 `python manage.py install_local_simulation_rules --channel TEXT_TTS` 或 `--channel VOICE_INTERCOM` 安装。语音规则只生成沙箱回执，不授权真实省平台动作。
- 司机回传录音/转写接口目前仅在服务器侧预留，默认关闭；需要书面同意和可审计同意引用，真实平台 WebSocket/音频帧链路尚未接通。

插件优先监听页面已经发出的白名单 `fetch/XMLHttpRequest`；只有页面已有成功查询且监听不到变化时，才使用固定3秒白名单轮询兜底。在原始证据之外生成标准报警事件，匹配版本化规则，并形成值班台账。默认演练模式不会连接真实车辆，也不会触发查岗响应、报警忽略、正报或申诉按钮。

> 当前源码版本：`0.5.5`。真实联调已确认实时监控页 `#/vehicle-monitor/real-time` 中 `getVideoUnprocessedAlarm` 对应“预警列表”；同页内部的“实时报警”页签请求 `alarmQueryList` 必须归类为正式实时报警，“预警列表”页签请求才归类为 `PREWARNING`。插件优先监听页面主动请求，只有监听不到且页面已有成功查询时才按3秒周期兜底采集，无需刷新整页。平台数据到达后目标是在1秒内进入插件展示。自动动作由已发布规则选择 `TEXT_TTS` 或 `VOICE_INTERCOM`；真实语音/文本适配器仍需在测试车辆上完成授权联调。

省平台已确认允许插件以低频定时点击维持当前授权会话。扩展只在管理员启用策略、实名单位使用人员已认领班次、页面严格位于 `#/alarm-center/alarm-preprocessing` 且恰好存在一个可见可用的“查询”按钮时执行一次点击；其他路由、目标缺失/重复、登录页、验证码或人机挑战一律跳过。插件不会自动登录、处理挑战，也不会把这项授权扩展到文本、语音或处置按钮。登录恢复后仍必须优先补采“实时报警”和“技术检测”。

预报警页面为 `#/alarm-center/pr-alarm-recorde`。当前插件会在该页面加载或人工查询时正确归类 `PREWARNING`，并按秒显示最近捕获新鲜度；平台尚未单独授权插件定时点击该页面的“查询”，所以不会以保活授权推定主动刷新权限。

## 内部记录白名单

- 报警：报警类型、实时未处理报警、报警查询、未处理计数、报警详情、技术报警。
- 关联数据：车辆组织树、车辆详情、车辆分类。
- 查岗：查岗列表。

这些接口来自项目内部授权勘察记录，不属于官网公开 API，仍需在当前授权账号
和真实页面中逐项复核。请求方法、URL、路由、请求体、响应状态、响应数据和
耗时会保存；认证头以及请求/响应中的密码、token、session、secret、手机号等
字段会自动脱敏。单条文本响应上限为 5MB。

## 运行

要求 Node.js 20+，不需要安装第三方依赖。

```powershell
cd browser-extension
npm.cmd test
$env:COLLECTOR_DATA_KEY="<URL-safe-base64 key decoding to 32 bytes>"
npm.cmd start
```

`COLLECTOR_DATA_KEY` is mandatory. Without it, `/ready` and all persistence endpoints return HTTP 503. Collector records use AES-256-GCM encrypted lines; plaintext full JSON is never written to disk. Browser storage does not queue raw captures and only keeps a bounded 24-hour operational cache of normalized events.

For this Windows workstation, the collector can be started with `powershell -ExecutionPolicy Bypass -File .\start-secure-collector.ps1`. The script reads the current-user DPAPI-protected key from `%LOCALAPPDATA%\HNAlarmAssistant\collector-key.dpapi`; the plaintext key is never written into the project directory.

采集服务默认监听 `127.0.0.1:17321`，数据持续追加到：

- `collector-data/captures-YYYY-MM-DD.encjsonl`：加密的完整白名单请求/响应。
- `collector-data/alarms-YYYY-MM-DD.encjsonl`：加密的逐条报警记录。
- `collector-data/alarm-events-YYYY-MM-DD.encjsonl`：加密的标准报警事件。
- `collector-data/decisions-YYYY-MM-DD.encjsonl`：加密的规则匹配结果。
- `collector-data/action-attempts-YYYY-MM-DD.encjsonl`：加密的动作尝试。
- `collector-data/ledger-YYYY-MM-DD.encjsonl`：加密的值班台账快照。
- `collector-data/audit-YYYY-MM-DD.encjsonl`：加密的运行审计。

健康检查：

```bash
curl http://127.0.0.1:17321/health
```

就绪检查：`http://127.0.0.1:17321/ready`。

## 安装插件

1. 打开 Chrome/Edge 的扩展管理页并开启“开发者模式”。
2. 选择“加载已解压的扩展程序”。
3. 选择本目录 `browser-extension`。
4. 刷新已经登录的省平台页面。

页面右下角会显示当前版本的本机值班面板。`本地服务=已连接` 且接口计数增加，表示采集与落盘链路正常。服务临时未启动时，数据保存在浏览器扩展本地队列；服务恢复后每分钟自动重试。未登录实名助手账号时，插件保持只读采集，设置、备注和人工重试均被阻断。登录后，插件从 `127.0.0.1:18080/assistant/api/me` 读取服务端角色与企业范围，并按权限开放操作；运行规则从 `/assistant/rules/api/runtime` 同步后台唯一已发布版本，本地规则和音频导入入口已经移除。数据导出已从值班插件移除，统一进入后续独立报表中心；完整 JSON 只能通过受控敏感证据包流程申请。

插件还会把浏览器页面可见的省平台身份观察信号（显示姓名、未核验状态、可见范围摘要和权限布尔信号）随设备心跳上报；这些信号不等于正式账号核验，无法核验时仍禁止真实动作。

本地Django契约沙箱运行在 `127.0.0.1:18080`。扩展提供独立“沙箱动作”模式，可调用沙箱模拟对讲接口；该模式与真实平台动作严格分离。

点击面板中的“查看最近抓取”可查看当前页面最近 20 条白名单请求；点击任一记录
可展开脱敏后的完整请求与响应 JSON。该调试列表在页面刷新后清空，长期数据仍以
`collector-data` 中的 JSONL 文件为准。

## 规则、文本模板和固定音频

- 运行时规则由后台规则治理中心发布；`default-rules.json` 仅为断线时的安全待确认草案。
- 当前 Schema V2 的自动规则默认使用一个主渠道；只有规则明确配置提醒策略时，才允许增加一个文本/TTS失败兜底或成功后补充渠道，并生成独立的响应计划与回执。
- 文本必须引用已发布固定模板；语音必做/语音优先、内部确认和无法判断转人工的规则见 `docs/product/司机提醒与纠正检测规则-v1.md`。结果未知、超时或阻断时禁止自动切换渠道。
- 后台会拒绝畸形时间段、重复ID、同条件同优先级冲突、未发布响应资产和越权企业范围。
- WAV只接受PCM、8kHz、16bit、单声道，导入后记录SHA-256。
- 无匹配、冲突、未确认或字段不足统一转人工。

## 真实文本与语音边界

真实动作必须同时满足：规则和对应文本/语音资产已发布、实名权限与企业范围有效、真实动作模式、车辆白名单、会话正常和调用链已验证。测试车辆尚未完成前，真实 `TEXT_TTS` 和 `VOICE_INTERCOM` 均由适配器阻断；明确失败按5秒、10秒重试，30秒内转人工，未知结果不重试。

## 当前边界

- `alarmDetails` 已加入监听；它的真实请求参数会在人工打开报警详情时自动原样记录。
- 插件保存的是白名单网络证据；公开官网事实、内部实操事实和待验证假设不能混写。
- 真实文本和语音安全闸门与阻断分支已实现；生产适配器尚未实现，获得客户授权并完成测试车辆联调前不会调用平台动作接口。
- 当前不调用文本下发、查岗响应、忽略、正报和申诉接口。
- 真实报警弹窗 DOM 和对讲按钮属于下一阶段联调，不影响本阶段接口数据采集。
