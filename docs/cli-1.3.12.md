# CLI 1.3.12 发布说明

1.3.12 已于 2026-10-16 发布到 npm，公开包安装验收通过；匹配版本的官网安装文件和 Skill 分发尚未上线。不能仅凭新 npx 代理已连接就认定全局 `shiliu` 已更新。

版本说明统一使用 `docs/cli-<版本>.md`，本文件是 1.3.12 的版本记录。`RELEASE_CLI.md` 只维护跨版本通用发布流程，不复制各版本变更及发布结果。

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
- SDK 升到 1.32.1，fast-uri / ip-address / proxy-addr 更新到兼容修复版；当前候选 npm audit 为 0，131 项完整测试及最低 Node 18.14.1 验证通过。逐项引入链和适用性结论在依赖评估中记录。
- 固定 Node 18 兼容的 @hono/node-server 1.19.17，避免全新消费安装解析到要求 Node 20 的 2.x；CI 增加精确最低版本下的严格 engines 打包安装验证。

旧用户更新后应分别核对 `shiliu --version` 和 MCP 重连。CLI 无法可靠推断其他 PATH/Node/npm 前缀下的全局命令版本，故不作虚假的自动升级判断。

发布依赖评估见 [cli-1.3.12-dependencies.md](cli-1.3.12-dependencies.md)。该评估同时列出新增锁库、四项告警的修复/适用性及全新消费安装结果；依赖结论已完成复核，公开消费安装结果见下文。

执行前逐项授权的发布清单见 [cli-1.3.12-release-plan.md](cli-1.3.12-release-plan.md)。P2 按 [cli-p2-plan.md](cli-p2-plan.md) 分开交付：参数错误和 JSON 契约修复已单独提交 [PR #24](https://github.com/bigbrain-work/shiliu-ai/pull/24)，作为 1.3.13 候选，不包含在 1.3.12 中。

本次不修改额外的余额验收要求，不包含 `RELEASE_CLI.md` 的本地历史记录。

## 2026-10-16 发布结果

- [PR #23](https://github.com/bigbrain-work/shiliu-ai/pull/23) 已合入，发布提交为 `3fd6a9624192397fd0e3e4541a1ce8814dc397f2`，合入后的三项 CI 均通过。
- [npm 发布工作流](https://github.com/bigbrain-work/shiliu-ai/actions/runs/38838791418) 第二次尝试成功，通过 GitHub Actions OIDC 可信发布并附 provenance；公开 registry 的 latest 为 1.3.12。首次尝试因缺少可信发布配置失败，配置补齐后重试成功。
- 公开 tarball 的 SHA512 integrity、SHA1 均匹配 registry 元数据，37 个包文件与发布提交逐字节一致；SHA256 为 `4df6cc5aab3cc41982d82480c556c2958f44ef95425fa0438b8b9626ca023e90`。
- Node 18.14.1 + npm 9.9.4 下，使用全新前缀及全新 npm 缓存对公开版本执行 `--engine-strict` 安装成功，消费依赖 audit 为 0。SDK 为 1.32.1、Hono node-server 为 1.19.17，三个修复后的传递依赖版本与依赖评估一致。
- 9 个公开包入口检查通过：版本、三个客户端乘两种 scope 的安装路径 dry-run、普通及 force 未登记 refresh。未登记 Git 项目文件摘要不变，隔离用户目录未创建。
- 使用公开包及 Node 18.14.1 完成生产 MCP stdio 初始化，发现 31 个工具，免费余额查询成功且 `charged=false`，ping 成功，没有调用付费工具。此项使用 SDK 驱动，不代替真实客户端发现验收。

仍待完成：官网三个安装文件与完整 Skill 分发上线、旧用户升级通知、真实 Codex/Claude Code/Cursor 客户端发现 Skill，以及真实 macOS Keychain/Linux Secret Service 刷新验收。未登记旧副本不会因 npm 发版而自动更新或删除。
