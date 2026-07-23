# 三客一危实名助手服务

本目录是浏览器扩展配套的 Django 正式助手服务，只提供实名身份、角色与企业范围、值班班次、规则与响应资产治理、全局动作租约、报警事实、处置工单、五来源报表任务、导出和审计能力。

演练平台、模拟报警、模拟文本、模拟对讲以及 `/sandbox/*` 路由已全部移除。真实省平台凭证不进入 Django；语音、文本和平台已处理动作只能由浏览器扩展在用户已登录的省平台标签内执行。

## 本地启动

```powershell
cd server-code-0.5.4
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
powershell -ExecutionPolicy Bypass -File deploy/windows/start-assistant-postgresql.ps1
```

本机实际运行和正式环境统一使用 PostgreSQL。Windows 本机启动脚本为 `deploy/windows/start-assistant-postgresql.ps1`，它从当前 Windows 用户环境读取数据库连接和密钥、执行迁移，再使用 Waitress 监听 `127.0.0.1:18080`。SQLite 仅保留为迁移前备份和自动化测试兼容入口，不再承载插件实时写入。

历史加密数据迁移时可以临时配置 `SENSITIVE_DATA_KEY_FALLBACKS`（逗号分隔的32字节 URL-safe base64 密钥）。回退密钥只用于读取旧密文；所有新写入始终使用 `SENSITIVE_DATA_KEY`。完成统一重加密和验收后应移除回退密钥。

正式环境必须设置 `ASSISTANT_DEBUG=0`、独立的 `ASSISTANT_SECRET_KEY`、PostgreSQL `DATABASE_URL`、允许域名、CSRF 来源以及独立的数据加密密钥；正式环境使用 Gunicorn 或 Waitress，不使用 `manage.py runserver`。

## 健康检查

- `GET /health`：进程存活。
- `GET /ready`：确认实际使用 PostgreSQL、数据库可写且没有待应用迁移；响应不包含账号、密码或连接串。
- `GET /assistant/api/me`：当前实名账号、角色、企业范围和班次。

## 真实动作边界

- 插件只能读取后台当前已发布规则和已发布响应资产。
- 真实动作前必须通过实名权限、当前班次、企业范围、平台身份、设备登记和全局租约检查。
- 语音、文本/TTS、平台已处理登记分阶段执行，每个阶段前重新核验动态安全条件。
- 失败、超时、结果未知、规则撤回、资产变化、会话变化或租约失效时立即停止并转人工。
- 同一报警和同车同类报警由服务端动作租约与冷却窗口阻止多账号重复、并发下发。

## 五来源报表

报表任务固定使用以下来源：

- `ALARM_DISPOSAL_RATE`
- `ALARM_PROCESSING_RATE`
- `ALARM_CENTER`
- `VEHICLE_BASE_INFO`
- `TRACK_COMPLETENESS`

Django 冻结任务、校验分页和字段签名、按企业生成报警日报/周报/月报与车辆动态监控日报；浏览器扩展仅在现有省平台授权会话内调用已确认白名单接口。缺页、字段变化、周期错误或范围无法确认时任务进入 `DATA_INCOMPLETE`，不生成正式文件。

## 测试

```powershell
.\.venv\Scripts\python.exe manage.py test --settings=config.settings_test
```

SQLite 升级 PostgreSQL 的停写、备份、迁移、核对、密钥轮换和回滚步骤见 [SQLite 到 PostgreSQL 迁移手册](docs/sqlite-to-postgresql-migration.md)。

部署步骤见 [README-部署说明.md](README-部署说明.md) 和 `deploy/linux-postgresql.md`。
