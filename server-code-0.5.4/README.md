# 三客一危省平台契约沙箱

本目录是供浏览器插件开发使用的本机Django模拟环境。它复刻当前已知接口路径、字段样例、报警列表、证据区、详情弹窗和异常场景，不声称是省平台的完整实现。

演练触发、模拟文本和模拟对讲接口仅在 `SANDBOX_DEBUG=1` 时注册；生产模式只保留 `/health` 和检查数据库的 `/ready`，不会暴露沙箱动作路由。

正式部署继续使用 Django，不引入 FastAPI。开发环境未设置 `DATABASE_URL` 时使用 SQLite；当 `SANDBOX_DEBUG=0` 时必须提供 PostgreSQL `DATABASE_URL`，否则服务拒绝启动。Linux/Docker 使用 Gunicorn，Windows 原生服务使用 Waitress，生产环境禁止使用 `manage.py runserver`。

## 启动

需要 Python 3.11+ 和 Django 5.2：

```powershell
cd sandbox
python manage.py migrate
python manage.py runserver 127.0.0.1:18080
```

打开：`http://127.0.0.1:18080/`。

### 实名助手账号

首次联调前通过环境变量提供不少于12位的本机密码，再创建实名账号。密码不会写入命令参数或仓库：

```powershell
$env:ASSISTANT_BOOTSTRAP_PASSWORD="请替换为本机强密码"
python manage.py bootstrap_assistant --username local-admin --display-name "本地系统管理员" --employee-code LOCAL-ADMIN --role SYSTEM_ADMIN
Remove-Item Env:ASSISTANT_BOOTSTRAP_PASSWORD
```

访问 `http://127.0.0.1:18080/assistant/login` 登录。浏览器插件只读取服务端实名会话和权限；没有实名档案的普通 Django 账号不能进入助手系统。

同时启动插件本机采集服务：

```powershell
cd ..\browser-extension
npm.cmd start
```

在Chrome/Edge扩展页重新加载 `browser-extension/`，然后刷新沙箱页面。

## 首次演练规则

页面顶部可下载：

- `audio-sandbox-v1.wav`：1秒、8kHz、16bit、单声道PCM测试音频。
- `sandbox-rules.json`：匹配报警类型ID `64` 的已确认沙箱规则，只允许演练或本机沙箱动作，不允许真实对讲。

先在插件设置中用资产ID `audio-sandbox-v1` 导入并确认测试音频，再导入规则JSON：

- 保持“演练模式”可验证不访问任何对讲接口的规则闭环。
- 切换“沙箱动作”可让插件调用 `127.0.0.1:18080` 的模拟对讲接口，验证成功和失败回执。

点击页面顶部“触发新报警”，即可验证采集、归并、规则、动作和台账。

## 场景

| 场景 | 行为 |
| --- | --- |
| 正常流程 | 返回已知字段和10条分页记录 |
| 重复报警 | 同一响应重复第一条报警，用于验证业务去重 |
| 字段缺失 | 移除驾驶员、企业和位置 |
| 响应结构变化 | 使用 `result.records` 替代 `data` |
| 登录失效 | 业务接口返回401 |
| 服务异常 | 业务接口返回500 |
| 慢响应 | 业务接口延迟约1.2秒 |
| 对讲失败 | 沙箱对讲按钮返回503并留下尝试记录 |

场景控制接口仍保持可用，以便从异常场景切回正常。

## 已模拟接口

- 报警类型、实时未处理报警、报警查询、未处理计数、报警详情、技术报警。
- 车辆组织树、车辆详情、车辆分类。
- 查岗列表。
- 沙箱触发报警、场景切换、重置和模拟对讲回执。

真实平台接入仍需校准接口契约、鉴权、DOM选择器和动作回执，不能只修改域名后直接上线。
