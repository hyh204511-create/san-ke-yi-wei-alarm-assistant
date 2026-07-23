# 三客一危省平台值班助手

## 0.6.0 真实自动运行与正式报警统一分类（以本节为准）

- `SYSTEM_ADMIN` 独占报表生成、发布、导出和下载权限。
- `RULE_CONFIGURER` 只能起草、修改和提交规则；审核与发布由 `RULE_REVIEWER` 完成。
- `UNIT_USER` 为采集员，只能查看授权报警数据、读取已发布运行规则、提交设备心跳和保活审计，不能处置、执行业务动作或导出报表。
- `MONITOR_OPERATOR` 是独立的监控操作员角色，承接需要班次和动作租约的真实处置，不得与采集员、规则配置员或规则审核员混用。
- 保活白名单覆盖三个固定页面：报警预处理页唯一“查询”按钮（允许点击）、实时监控页（只读观察）、预警列表页（只读观察）。不导航、不刷新、不点击任意业务按钮；登录页、验证码和人机挑战直接跳过并转人工。
- 实时监控页的正式报警由平台 SharedWorker 消息 `funCode=ALARM_ADD` 且 `alarmKind=1` 推送，插件只旁路监听并归类为 `REALTIME`；`alarmKind=0` 以及 `getVideoUnprocessedAlarm` 继续归类为 `PREWARNING`。
- `REALTIME` 与 `PENDING` 都属于同一个用户可见的“正式报警”类别；二者继续保留独立 `sourceKind` 和来源接口，用于证据追溯、规则兼容和来源排序，面板不再拆成两个正式报警页签。
- 自动动作队列始终先选择命中后台已发布规则的新鲜 `REALTIME/PENDING` 正式报警；只有不存在可执行正式报警时，才回退到已审核的“超速驾驶”预报警。已经执行、结果未知、已处理或服务器租约冲突的报警不会重复下发。
- 插件从其他页面收到可执行报警时，只按唯一菜单路径“值班值守监控 → 实时监控”进入 `#/vehicle-monitor/real-time`，再自动切换“实时报警/预警列表”页签，并以车牌、报警类型和发生时间唯一核对报警行；缺失或歧义时立即阻断并转人工。
- 已发布规则可为正式报警配置语音或文本/终端 TTS；所有已配置渠道取得明确成功回执后，插件才调用平台“已处理”登记。任一结果未知、超时或阻断都会停止后续动作。
- 实时监控页活动页签无法确认时，`alarmQueryList` 只进入 `alarm-center-discovery` 发现记录，不伪装成历史查询或正式报警。

## 0.5.4 秒级处理与提醒策略口径

- “秒级”指平台响应到达插件后，目标在 1 秒内完成本地标准化、分类、规则匹配和面板刷新；不代表每秒请求或点击省平台。
- `PREWARNING` 是平台预报警：实时捕获、立即展示和入库；只有后台已发布的明确规则可以授权真实动作，当前仅开放新鲜超速驾驶预警，原始来源仍保持 `PREWARNING`。
- `REALTIME`、`TECHNICAL`、`PENDING` 属于正式报警处理范围，进入优先队列并按已发布规则处理。
- 自动规则固定采用单一渠道：规则选择 `TEXT_TTS`（文本下发并启用终端TTS）或 `VOICE_INTERCOM`（自动建立语音对讲并播放固定语音）。
- 自动失败只允许明确 `FAILED` 重试，默认5秒、10秒两次；总计时达到30秒仍未明确成功就转当前值班人员处理。
- 超时、结果未知、验证码、会话失效或真实适配器未联调时记录并通知值班人员，不自动重试或切换渠道。
- `VOICE_INTERCOM` 收到成功回执后仍生成 `VOICE_REVIEW_REQUIRED`，提醒当前值班人员审核动作记录；这不代表已接通真实司机回传录音。
- 司机回传录音/转写接口目前仅在服务器侧预留，默认关闭；需要书面同意和可审计同意引用。平台 SharedWorker 的报警消息已接通只读捕获，真实语音/音频帧链路仍未接通。

插件优先监听页面已经发出的白名单 `fetch/XMLHttpRequest`；只有页面已有成功查询且监听不到变化时，才使用固定3秒白名单轮询兜底。在原始证据之外生成标准报警事件，匹配版本化规则，并形成值班台账。插件固定为真实自动运行，不提供演练、沙箱或单条手工动作入口；未被已发布规则明确授权的动作一律记录或转人工。

> 当前源码版本：`0.6.0`。真实页面观测记录（2026-07-23）：实时监控页与插件正式报警数量已同步验证，扩展重新加载后的本地回填有效。插件优先监听页面主动请求和已存在的只读长连接消息，只有监听不到且页面已有成功查询时才按3秒周期兜底采集，无需刷新整页。自动动作由已发布规则选择，并在实名权限、企业范围、当前班次、省平台会话和后台全局租约全部有效时调用真实语音/文本适配器。

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

源码更新后必须重新加载当前解压目录，旧版 `browser-extension.crx` 不是当前源码的验证包；已打开的真实页面需要由用户按既有授权流程重新注入新版本。助手不代替用户点击扩展管理页或平台业务按钮。

页面右下角会显示当前版本的本机值班面板。`本地服务=已连接` 且接口计数增加，表示采集与落盘链路正常。服务临时未启动时，数据保存在浏览器扩展本地队列；服务恢复后每分钟自动重试。未登录实名助手账号时，插件保持只读采集，设置、备注和人工重试均被阻断。登录后，插件从 `127.0.0.1:18080/assistant/api/me` 读取服务端角色与企业范围，并按权限开放操作；运行规则从 `/assistant/rules/api/runtime` 同步后台唯一已发布版本，本地规则和音频导入入口已经移除。数据导出已从值班插件移除，统一进入后续独立报表中心；完整 JSON 只能通过受控敏感证据包流程申请。

插件还会把浏览器页面可见的省平台身份观察信号（显示姓名、未核验状态、可见范围摘要和权限布尔信号）随设备心跳上报；这些信号不等于正式账号核验，无法核验时仍禁止真实动作。

本地 Django 助手运行在 `127.0.0.1:18080`，提供实名权限、班次、规则、全局动作租约、审计和报表任务服务；扩展不提供沙箱动作模式。

### 五来源报表契约记录

- 用户重新加载当前解压扩展并刷新既有省平台标签后，人工进入“处置率、处理率、报警查询、车辆基础信息、轨迹完整率明细”页面并按业务规则执行查询。
- 插件只旁路记录当前页面已经发出的 fetch/XHR，不点击查询、导出或业务按钮；记录按来源标记并由本机采集服务 AES-256-GCM 加密保存。
- 运行 `npm run analyze:report-contracts` 会读取 DPAPI 保护的本机密钥，生成忽略提交的 `contract-summary.local.json` 和 `report-contract-candidates.local.json`。输出只含净化路径、字段结构、分页和统计信息，不含真实业务值或认证凭证。
- 五个来源全部达到 `READY_FOR_REVIEW` 且人工核对筛选范围后，才能把候选写入正式白名单。候选生成不会自动设置 `enabled=true`。

报警详情会显示服务端统一的“系统处理状态、处理状态来源、处理状态时间”。`PROCESSED` 和 `UNKNOWN` 是服务器终态，旧页面或其他账号上传的过期动作快照不能把终态退回“处理中”；即使动作租约明细以后清理，终态仍阻止重复下发。

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

真实动作必须同时满足：规则和对应文本/语音资产已发布、实名权限与企业范围有效、当前班次有效、省平台会话正常、平台身份可确认且后台全局动作租约已取得。明确失败按已发布规则重试；超时、未知、字段变化、权限缺失或回执不完整立即停止并转人工，不自动伪造成功。

## 当前边界

- `alarmDetails` 已加入监听；它的真实请求参数会在人工打开报警详情时自动原样记录。
- 插件保存的是白名单网络证据；公开官网事实、内部实操事实和待验证假设不能混写。
- 真实文本、语音和平台已处理登记适配器已接入固定白名单接口；实际成功必须以省平台明确回执和后端审计记录为准。
- 当前不调用查岗响应、忽略、正报和申诉接口。
