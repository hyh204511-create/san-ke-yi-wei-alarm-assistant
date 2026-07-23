# 三客一危省平台 AI 报警处置助手

面向湖南省“三客一危”智能监管平台的浏览器辅助项目。

当前可运行实现包含：

- Chrome/Edge Manifest V3 采集与值班辅助扩展；
- 本机 Node.js JSONL 采集服务；
- 标准报警事件、字段来源追踪、版本化规则、演练动作、值班台账和页面内工作面板；
- Django 本地服务，包含契约沙箱、实名身份、RBAC、班次认领和规则治理中心。

插件默认处于演练模式，不会连接真实车辆。运行规则只能来自后台已审核发布版本；文本和语音资产/执行适配尚未完成时，后台会把自动渠道明确降级为人工处理。获得客户授权并完成测试车辆联调前，真实动作分支固定阻断。当前不会触发文本下发、查岗响应、报警忽略、正报或申诉按钮。`prototypes/` 中展示的是产品方向，不代表已经接通省平台生产动作。

## Quick start

要求 Node.js 20+，不需要安装第三方依赖。

```powershell
cd browser-extension
npm.cmd test
$env:COLLECTOR_DATA_KEY="<URL-safe-base64 key decoding to 32 bytes>"
npm.cmd start
```

健康检查：

```bash
curl http://127.0.0.1:17321/health
```

安装扩展：

1. 打开 Chrome/Edge 扩展管理页；
2. 开启开发者模式；
3. 选择“加载已解压的扩展程序”；
4. 选择仓库中的 `browser-extension/`；
5. 刷新已经授权登录的省平台页面。

本地实名助手使用 PostgreSQL：

```powershell
cd server-code-0.5.4
powershell -ExecutionPolicy Bypass -File deploy/windows/start-assistant-postgresql.ps1
```

启动脚本从当前 Windows 用户环境读取 `DATABASE_URL`、应用密钥和数据加密密钥，执行 Django 迁移后使用 Waitress 监听 `127.0.0.1:18080`。不得把数据库密码或密钥写入仓库。

首次打开 `http://127.0.0.1:18080/assistant/setup`，在仅限本机开放的初始化页创建系统管理员。随后进入“身份与企业管理”，创建监控、处置复核、规则配置、规则审核、报表和安全审计人员，并分配企业范围。监控、规则配置和规则审核账号由服务端强制互斥。

打开 `http://127.0.0.1:18080/assistant/`。服务端说明见 [`server-code-0.5.4/README.md`](server-code-0.5.4/README.md)。

## 目录

```text
browser-extension/  可运行扩展、本机采集服务和测试
server-code-0.5.4/  Django实名助手、PostgreSQL迁移和Windows/Linux部署入口
sandbox/            历史开发副本，不作为当前运行入口
docs/               产品、工程、决策、研究、交接和交付文档
prototypes/         当前原型、汇报页和历史原型
private/            本地客户证据和历史原始资料，不进入 Git
```

## 建议阅读顺序

1. [全栈接手 Handoff](docs/handoff/三客一危省平台AI报警处置助手-全栈接手Handoff-2026-07-18.md)
2. [扩展运行说明](browser-extension/README.md)
3. [核心需求与一期边界](docs/product/会议纪要核心需求与网页小助手处理记录.md)
4. [页面与数据采集记录](docs/engineering/网页插件建设-省平台页面与数据采集记录.md)
5. [当前产品原型](prototypes/current/index.html)

文档状态和权威性见 [docs/README.md](docs/README.md)，原型状态见 [prototypes/README.md](prototypes/README.md)。

## 状态边界

| 能力 | 状态 |
| --- | --- |
| 白名单 `fetch/XHR` 监听 | 已实现并有自动化测试 |
| 扩展临时队列与本机加密落盘 | 原始抓取不进浏览器队列；本机 `.encjsonl` 使用 AES-256-GCM，缺密钥拒绝落盘 |
| 页面采集状态面板 | 已实现 |
| 真实报警/查岗弹窗监听 | 待真实页面联调 |
| 跨接口事件归一与业务去重 | 已实现通用模型并有自动化测试，待真实字段校准 |
| 实名身份、角色和班次 | 已实现服务端会话、七类角色、职责分离、企业授权和班次认领 |
| 规则治理 | 已实现草稿、提交、审核、发布、回滚、哈希和审计；插件只同步已发布版本 |
| 企业范围强制隔离 | 已覆盖规则配置/审核/运行、插件报警展示、备注、重试和人工工单；待真实企业编码校准 |
| 真实语音对讲 | 安全闸门和阻断分支已实现；生产执行适配器未实现，待客户授权和测试车辆联调 |
| 值班台账与导出 | 插件已移除导出；本机服务仅保留开发期脱敏 CSV，完整 JSON 返回 403 |
| 人工处置工单 | 已实现接管、备注、提交结果、不同人员复核、退回、重开、版本冲突保护和追加式事件 |
| 文本/语音模板与动作 | 已实现独立草拟、审核、发布、企业范围、哈希、Schema V2 ResponsePlan 和文本/语音沙箱；生产适配器仍固定阻断 |
| 日报、月报 | 已实现独立报表中心、企业日报/月报、版本化快照、XLSX/PDF、用途/哈希/下载/过期删除审计 |
| 敏感证据包 | 已实现申请、不同人员审批、字段清单、AES-256-GCM、哈希、过期删除和下载审计；普通 JSON 下载仍禁止 |

完整覆盖结论见 [产品逻辑与插件覆盖审查](docs/product/产品逻辑与插件覆盖审查-2026-07-19.md)。

## 数据安全

本项目包含客户机密信息，只应使用私有仓库。

禁止提交：

- `private/`；
- `browser-extension/collector-data/`；
- 真实请求响应、车辆/司机/企业/位置数据；
- 原始视频、拆帧图片和平台静态资源；
- 账号、密码、验证码、Cookie、Authorization 或真实 Token。

公开官网事实、内部授权实操事实、原型演示和待验证假设必须分开记录。
