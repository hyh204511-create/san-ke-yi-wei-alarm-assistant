# Linux + 云 PostgreSQL 部署步骤

## 前置条件

- Linux 服务器已安装 Docker 或 Python 3.12；
- 云 PostgreSQL 已创建数据库、应用账号和白名单；
- 云 PostgreSQL 强制 TLS 时，将 `DATABASE_SSLMODE=require`；
- 生产环境必须提供独立的 `SENSITIVE_DATA_KEY` 和 `EVIDENCE_MASTER_KEY`（均为解码后32字节的 URL-safe base64）；服务会在启动时校验，不能使用开发派生密钥；
- 反向代理已经准备正式域名和 HTTPS；
- 服务器不需要访问省平台，省平台会话只在各使用人员浏览器中保持。

## Docker 启动

在 `sandbox` 目录：

可优先使用 [`deploy/docker-compose.production.yml`](docker-compose.production.yml)；其中只绑定本机 `127.0.0.1:8000`，云 PostgreSQL 不在 Compose 中运行：

```bash
cp .env.production.example .env.production
# 编辑 .env.production，填入真实域名、云PostgreSQL和密钥
docker compose -f deploy/docker-compose.production.yml build
docker compose -f deploy/docker-compose.production.yml up -d
docker compose -f deploy/docker-compose.production.yml exec assistant python manage.py migrate
docker compose -f deploy/docker-compose.production.yml exec assistant python manage.py collectstatic --noinput
docker compose -f deploy/docker-compose.production.yml exec assistant python manage.py check --deploy
```

Nginx 配置模板见 [`deploy/nginx/assistant.conf.example`](nginx/assistant.conf.example)，证书路径、域名和访问网段必须由 BOSS 替换确认。

如果服务器没有 Docker，也可以使用下面的等价 `docker run` 流程：

```bash
cp .env.production.example .env.production
# 编辑 .env.production，填入真实域名、云PostgreSQL和三类密钥
docker build -t three-passenger-assistant:0.5.3 .
docker run -d --name three-passenger-assistant \
  --env-file .env.production \
  -p 127.0.0.1:8000:8000 \
  -v assistant-report-exports:/var/lib/assistant/report-exports \
  -v assistant-evidence-exports:/var/lib/assistant/evidence-exports \
  three-passenger-assistant:0.5.3
docker exec three-passenger-assistant python manage.py migrate
docker exec three-passenger-assistant python manage.py check --deploy
```

首次启动前先完成迁移，再通过 Nginx 将 HTTPS 代理到 `127.0.0.1:8000`。不要把8000直接暴露给办公网。

## 非 Docker 启动

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DJANGO_SETTINGS_MODULE=config.settings
python manage.py migrate
python manage.py collectstatic --noinput
gunicorn --config gunicorn.conf.py config.wsgi:application
```

## 运行维护

每次发布：

```bash
python manage.py check --deploy
python manage.py migrate --plan
python manage.py migrate
```

每日维护任务：

```bash
python manage.py expire_action_leases
python manage.py purge_expired_exports
python manage.py purge_expired_voice_evidence --dry-run
python manage.py purge_expired_operational_data --dry-run
```

确认 dry-run 输出后，再执行：

```bash
python manage.py purge_expired_voice_evidence
python manage.py purge_expired_operational_data
```

建议将 `expire_action_leases` 单独配置为每分钟一次的 systemd timer；导出文件、运营数据和语音证据清理可每天执行。对应模板见 [`deploy/systemd/`](systemd/)。语音证据命令只会清除过期音频引用和转写内容，保留最小审计行；当前策略默认关闭，因此默认不会产生语音证据。

该命令默认保留365天；受处置工单或动作租约保护的报警事实不会强制删除，避免破坏审计链，需由数据负责人另行归档。

## 第一阶段网络边界

- Nginx只开放443；
- Django/Gunicorn只监听本机8000；
- 云 PostgreSQL只允许服务器出口IP；
- PostgreSQL不对办公网开放；
- 浏览器插件服务器地址通过受控部署配置注入；
- 未有 HTTPS 证书前只能在内网测试，不进入生产使用。
- `apps.platform_sim` 的演练触发、模拟文本和模拟对讲路由仅在 `SANDBOX_DEBUG=1` 注册；生产只提供根路径 `/health` 和会检查数据库的 `/ready`，不会暴露演练动作。
