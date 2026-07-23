# SQLite 到 PostgreSQL 迁移手册

本手册用于一次性迁移实名助手业务数据。数据库口令、应用密钥、加密密钥、SQLite 备份和临时 fixture 都不得进入 Git、聊天或日志。

## 1. 切换前

1. 停止插件写入和旧 Django/Waitress 进程，确认 `18080` 不再监听。
2. 将 SQLite 文件复制到仓库忽略的 `backup/postgresql-migration/`，记录文件 SHA-256、大小和时间。
3. 设置 `SQLITE_MIGRATION_SOURCE` 为备份的绝对路径，并使用 `--settings=config.settings_sqlite_migration` 执行全部 Django 迁移，确保源库结构与当前代码一致。该配置拒绝内存库、相对路径和不存在的文件，不能用于启动服务。
4. 记录每个 Django 模型的行数，以及管理员、已发布规则、响应资产、设备、报警事实、动作租约、审计和报表任务等关键对象数量。
5. 创建最小权限 PostgreSQL 应用角色和空数据库；应用角色不得拥有超级用户权限。

## 2. 受控迁移

1. 使用以下固定范围导出：仅 `auth.User`，以及 `governance`、`rule_governance`、`response_governance`、`disposals`、`reporting`、`evidence` 六个业务应用的全部模型；排除 `auth.Permission`、`auth.Group`、`contenttypes`、`sessions` 等重建或主动失效的数据。此范围与 `audit_database_migration` 命令共用同一口径。导出命令必须显式带 `--settings=config.settings_sqlite_migration`。
2. fixture 含解密后的业务字段，只能保存在受控本机临时目录。不得打印内容，不得上传或提交。
3. 为 PostgreSQL 设置新的 `DATABASE_URL` 和稳定应用密钥。迁移旧密文时，可临时设置 `SENSITIVE_DATA_KEY_FALLBACKS`；主密钥必须放在 `SENSITIVE_DATA_KEY`。
4. 对空 PostgreSQL 执行 `migrate --noinput`，再按依赖顺序导入 fixture。
5. 使用 Django 的 `sqlsequencereset` 输出并执行序列修正，防止后续新增记录主键冲突。
6. 通过 ORM 逐条读取并重新保存所有加密字段，使新密文只使用主密钥。
7. 立即安全删除临时明文 fixture，并确认 Git 状态中没有数据库、fixture 或备份文件。

迁移前后分别运行 `audit_database_migration`。源库命令显式使用离线 SQLite settings，目标库使用正常 PostgreSQL settings。该命令只输出数据库类型、逐模型行数和已成功解密的字段数量，不输出业务值。两份结果的逐模型行数和加密字段数量必须一致；目标库移除回退密钥后还必须再次通过。

## 3. 强制验收

1. 逐模型比较源库和目标库行数；总数相同不能代替逐模型核对。
2. 核对关键对象、外键关系、唯一约束和 PostgreSQL 序列当前值。
3. 移除 `SENSITIVE_DATA_KEY_FALLBACKS` 后，遍历读取全部加密字段；任一字段不可解密即停止切换。
4. 执行全量 Django 测试、`manage.py check` 和 `manage.py migrate --check`。
5. 启动 Waitress 后调用 `/ready`；必须返回 `database.engine=postgresql`、`writable=true`、`migrations_applied=true`。
6. 登录实名助手，验证账号、角色、企业范围、规则、资产和设备心跳。省平台真实动作仍只允许由插件执行。

## 4. 切换与回滚

- 验收通过后，保持 SQLite 备份只读，不再承载任何实时写入；移除回退密钥。
- 若导入、数量、解密、迁移或就绪检查任一失败，停止 PostgreSQL 服务，不允许双写；恢复切换前的代码、环境变量和只读备份副本，再启动旧服务。
- 回滚后重新核对备份 SHA-256 和关键对象数量。修复原因后必须从原始只读备份重新迁移，不得在失败的目标库上继续拼接数据。
