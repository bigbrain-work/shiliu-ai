# CLI 1.3.12 候选说明

本文件描述本地候选，尚未推送或发布。发布时先验证公开 npm 包，再上线匹配版本的官网安装文件；不能仅凭新 npx 代理已连接就认定全局 `shiliu` 已更新。

版本说明统一使用 `docs/cli-<版本>.md`，本文件是 1.3.12 的唯一版本记录；发布后在本文件补充实际提交、分发验证和发布日期。`RELEASE_CLI.md` 只维护跨版本通用发布流程，不复制各版本变更及发布结果。

本次还需要同步发布匹配的 Skill 归档、逐文件内容、摘要及索引，才能把“正常跳过、静默继续”的新指令交付给用户。仅更新 CLI 或安装指南不会替换已加载的旧 Skill。已登记目标可以在新归档上线后刷新；未登记旧副本仍需显式登记或人工清理。不得声称它们已自动迁移。

- 三个内置客户端及显式 `--target-dir` 统一从官网 HTTPS 索引下载归档，校验 SHA-256 并原子安装，不执行外部 skills CLI。完整流程最低 Node.js 18.14.1。
- Claude Code 的项目目标为 `.claude/skills`，用户目标尊重 `CLAUDE_CONFIG_DIR`；Codex/Cursor 为 `.agents/skills`。刷新使用持久化的实际路径。
- 未登记目标返回 `skipped / target_not_registered`，退出 0；不下载、不安装、不向新项目写文件，`--force` 不能改变边界。
- 缺失或旧错误路径只报告，显式 `skill install` 才能补装或改目标。保留其他客户端和共享副本。
- 未登记遗留副本仅报告。扫描最多到当前 Git 根；非 Git 目录只查 cwd；排除 user scope 和所有已登记路径。不要删除整个 `.hermes/skills` 或共享 `skills-lock.json`。
- 1.3.11 曾在未登记项目里运行安装；升级不会自动删除这些旧文件。请在显式升级/诊断时查看 refresh JSON 的 `unmanagedInstallations`，选择登记或手动清理具体副本。普通任务静默继续，不自动采取行动。
- 设备令牌刷新使用跨进程锁和锁内重读；`invalid_grant` 会重读一次，必要时等待 300ms 再读，兼容仍在运行的旧代理，避免把竞争误判成必须重新扫码。
- 锁最多等待约 30 秒；等待耗尽的 `ELOCKED` 是 `CREDENTIAL_UNAVAILABLE`，不要求重新扫码，锁释放后下次检查可恢复。单进程检查去重，5 秒轮询不堆积。keyring 子进程本身仍无超时，属于待处理事项。
- 默认凭据锁按 `os.homedir()` 定位，CLI 的 `--home` 不会改变锁目录；测试在隔离目录中验证，不影响生产的共享锁。
- 拒绝非法 tar 条目时通过 Promise 报错并清理 staging，不在 tar 回调里向事件循环抛异常。

旧用户更新后应分别核对 `shiliu --version` 和 MCP 重连。CLI 无法可靠推断其他 PATH/Node/npm 前缀下的全局命令版本，故不作虚假的自动升级判断。

发布依赖评估见 [cli-1.3.12-dependencies.md](cli-1.3.12-dependencies.md)。该评估同时列出新增锁库及四项既有审计告警；测试通过不代表完成依赖安全验收。

本次不修改额外的余额验收要求，不包含 `RELEASE_CLI.md` 的本地历史记录，不执行 npm 或后端发布。
