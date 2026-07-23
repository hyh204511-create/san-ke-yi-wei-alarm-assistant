# 三客一危 AI 报警助手：Django 服务器代码包

这是交给 BOSS 部署的服务器端代码包，版本 `0.5.4`。本包只包含 Django 后端、迁移、模板、生产配置示例和部署文件，不包含真实业务数据库、导出文件、日志、缓存、Cookie、Token 或省平台账号密码。

## 技术边界

- 后端：Django 单体应用，提供身份、角色、企业权限、报警接收、服务器去重、处置工单、审计、保活审计和日报/月报接口。
- 数据库：本地开发可用 SQLite；生产环境必须使用 PostgreSQL。
- 进程：Linux/Docker 使用 Gunicorn 多 worker；不要使用 `manage.py runserver` 承载生产流量。
- 通信：浏览器插件通过现有 REST 接口和心跳轮询上报，不新增 FastAPI、WebSocket 或第二套认证系统。
- 正报口径：`AlarmFact.source_kind = REALTIME`；`PREWARNING` 不计入正报。

## 生产部署（Docker，推荐）

1. 将 `.env.production.example` 复制为 `.env.production`，只在服务器上填写真实值；不要把该文件提交或发回聊天窗口。
2. 至少更换以下值：`ASSISTANT_SECRET_KEY`、`DATABASE_URL`、`SENSITIVE_DATA_KEY`、`EVIDENCE_MASTER_KEY`、`COLLECTOR_DATA_KEY`、允许的域名和 CSRF 来源。
3. 确认 PostgreSQL 已创建数据库和应用账号，并限制只允许服务器出口 IP 访问。
4. 执行：

```bash
cp .env.production.example .env.production
docker compose -f deploy/docker-compose.production.yml build
docker compose -f deploy/docker-compose.production.yml up -d
docker compose -f deploy/docker-compose.production.yml exec assistant python manage.py migrate
docker compose -f deploy/docker-compose.production.yml exec assistant python manage.py collectstatic --noinput
docker compose -f deploy/docker-compose.production.yml exec assistant python manage.py check --deploy
```

5. 由 Nginx 或内网网关代理到本机 `127.0.0.1:8000`，对外只开放 HTTPS；不要暴露 PostgreSQL 5432、Django/Gunicorn 内部端口或采集服务端口。

## Linux 原生部署

参考 `deploy/linux-postgresql.md`。安装 `requirements.txt` 后，在虚拟环境中执行迁移和静态文件收集，再使用 `gunicorn.conf.py` 启动。维护命令应交给 systemd timer 或受控 cron。

## 首次创建助手管理员

在服务器上临时设置强密码环境变量，创建完成后立即清除环境变量：

```bash
export ASSISTANT_BOOTSTRAP_PASSWORD='仅在服务器终端临时使用的强密码'
python manage.py bootstrap_assistant \
  --username local-admin \
  --display-name '系统管理员' \
  --employee-code LOCAL-ADMIN \
  --role SYSTEM_ADMIN
unset ASSISTANT_BOOTSTRAP_PASSWORD
```

之后由系统管理员在后台创建其他账号、企业范围、规则配置人员、规则审核人员和单位使用人员。每个省平台账号只保存脱敏引用，不保存省平台密码、Cookie、Authorization 或 Token。

## 权限边界（0.5.5）

- `SYSTEM_ADMIN`：唯一可以生成、发布、导出和下载日报/月报；同时负责用户、企业范围和保活策略配置。
- `RULE_CONFIGURER`：只能起草、修改和提交规则；审核与发布由 `RULE_REVIEWER` 完成。
- `UNIT_USER`：采集员只读查看授权报警数据，读取已发布运行规则，并提交设备心跳/保活审计；不能处置、执行业务动作或导出报表。
- `MONITOR_OPERATOR`：独立承接需要班次和动作租约的真实监控处置，不得与采集员、规则配置员或规则审核员混用。
- 保活固定白名单为报警预处理页唯一查询、实时监控页只读观察、预警列表页只读观察；不支持任意选择器、导航、刷新或业务按钮点击。

## 验证

```bash
python manage.py check --deploy
python manage.py test --verbosity 1
```

健康检查：

- `/health`：进程存活检查；
- `/ready`：数据库和加密持久化就绪检查；
- `/assistant/login`：助手账号登录入口；
- `/assistant/reports/`：日报/月报快照和 XLSX 导出入口。

## 需要 BOSS 提供/确认

- 服务器操作系统、固定内网地址、HTTPS 域名和证书；
- PostgreSQL 地址、端口、数据库名、账号、SSL 模式和备份/PITR；
- `ASSISTANT_ALLOWED_HOSTS` 与 `ASSISTANT_CSRF_TRUSTED_ORIGINS`；
- 数据、审计、导出文件和证据的保存周期；
- 服务器运维、备份恢复和安全补丁责任人。
