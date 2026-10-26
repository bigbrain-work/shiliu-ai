# CLI 1.3.19 发布记录

状态：2026-10-26 已正式发布 npm 1.3.19，并同步官网指南。发布源码为 PR #37 合入的 `eaba59315e1b2398cdbf28e6d15bbd17476a1706`；[GitHub Release](https://github.com/bigbrain-work/shiliu-ai/releases/tag/v1.3.19) 与 npm 版本一致。

## 修改内容

- 将直接依赖 Zod 从 `^3.25.0` 升级并固定为 `4.6.7`。当前 MCP SDK `1.32.1` 已支持 Zod 4，不修改 SDK 或业务工具协议。
- 继续保留本分支第一阶段的 body-parser 2.4.0、fast-uri 3.1.9、Hono 4.13.14 和配套 qs 6.16.1 更新。锁定安装及 tarball 冷安装的生产依赖审计均为 0。
- `doctor` 增加只读的 `skill` 诊断：报告已知用户目录、当前项目及适用历史记录中的 Skill 路径、范围、登记状态和显式安装命令。支持只有时间戳、没有 target 的旧登记记录，也能提示错误 Claude 路径等需要迁移的记录。
- `skill install --dry-run` 增加 `existingInstallation`，文本输出提示选定路径已有 Skill，正式执行会更新并登记这个路径。
- `doctor` 的新增模块只引用 Node 内置模块，SDK、Ajv 等依赖损坏时仍可以诊断。Skill 检查失败不覆盖 stdio 本身的诊断结果。
- 更新 CLI README 及安装指南中的旧安装处理说明，不提高原有安装器最低 CLI 版本。

## 安装边界

普通任务及 `skill refresh` 不会自动接管未登记的目录，`--force` 也不会改变这一点。
`doctor` 和安装演练只读检查，不写登记记录、不移动或安装 Skill。

用户可以先运行：

```text
shiliu doctor --dry-run --json
```

检查 `skill.installations`，确认路径与范围后，在对应 `registration.cwd` 执行其 `registration.command`。可以先附加 `--dry-run` 演练，确认后再显式安装。
需要迁移的登记记录见 `skill.issues`。执行命令只登记用户选定的位置，其他副本不会因此被自动登记、更新或删除。

客户无需单独安装 Zod，它随 CLI 自动安装。客户需要更新 CLI 才能获取本次程序依赖修复；只刷新 Skill 不会更新 Zod。

## 已完成的验证

| 验证 | 结果 |
| --- | --- |
| Node 22.16.0 完整测试 | 209 项通过，0 失败、0 跳过 |
| Node 18.14.1 完整测试 | 35 个测试文件通过，0 失败、0 跳过 |
| Windows 安装器行为 | 通过 |
| 分发完整性与安装器构建测试 | 14 通过、1 按平台条件跳过 |
| 官网资源候选构建和 Skill 校验 | 通过；7 个 Skill 文件及归档与此前发布一致 |
| 锁定依赖生产审计 | 0 漏洞 |
| Node 18.14.1 / npm 9.3.1 严格 engines 的 tarball 冷安装 | 通过；生产审计 0 漏洞 |
| tarball 内容 | 43 文件；增加内置模块 `skill-inspection.js` |
| 本机旧安装只读诊断 | 正确识别 `D:\program\.agents\skills\shiliu-ai-mcp` 未登记；没有修改用户的登记记录或安装 |
| 独立旧安装完整流程 | 诊断、演练、未登记强制刷新、显式安装并登记、登记后强制刷新均符合预期；另一副本保持原样；7 个公开 Skill 文件逐字节一致 |
| Claude Code 2.1.201 原生客户端 | 候选包握手及 35 项工具发现通过；原生免费余额调用 1 次，charged=false、consumed_credits=0；沿用默认模型和现有登录 |
| 本机配置保留及进程退出 | 原 MCP 配置、Skill 登记和旧 Skill 文件前后校验一致；仅本次候选进程启动并正常退出 |

完整测试包含 stdio 初始化、登录门禁、登录状态切换、远端 HTTP MCP 桥接、工具调用、Skill 安装刷新和依赖损坏后的 doctor/repair。新增测试覆盖未登记用户和项目副本、只登记选中路径、自定义安装目录、缺失目标、Claude 自定义用户目录、旧时间戳记录、损坏状态文件和命令引用。

本轮已在本机 Claude Code 完成原生 MCP 验收，未要求重新扫码，未进行付费业务调用；其他客户的具体 Agent 和运行平台不在这份验收范围内。测试没有重复扣费，也没有因为修改 CLI 而部署 Java 后端。

原生客户端验收使用与 tarball 的 43 个文件逐字节一致的独立安装。握手的 serverInfo.version 为 1.3.19，协议版本为 2025-11-25。工具目录和调用结果来自实际客户端协议流量，观察器不生成请求，并会在转发前阻断非验收工具调用。实际仅调用连接状态和免费余额工具，未发生阻断；35 项目录包含 32 个远端工具及 3 个本地登录/状态工具，四个达人相关工具均不含旧称谓。

候选 tarball SHA256：`23115ce63fb6660100a7d6cecedcaed7693059e608c7663f910c6ef20a0ed4e1`。验收证据保存在本次发布工作目录的 `native-1319/proof.json`、`wire-proof.json` 和配置前后校验中；公开说明不记录账号余额或凭据。

## 正式发布结果

1. PR 与合入 main 的 CI 均通过。正式发布工作流 `40317351578` 通过 Trusted Publishing 和 provenance 发布成功；registry 曾返回处理中，等待公开可用后才继续官网发布，没有重复发布。
2. 公开 npm latest 为 1.3.19。公开包的 SHA-512、SHA-1 与 registry 元数据一致，43 个文件逐字节匹配冻结 main，SHA256 与上面的原生验收候选一致。全新缓存、独立前缀的 Node 18.14.1 严格 engines 冷安装成功，审计为 0，9 项 smoke 通过。
3. 仅替换官网 `install.txt`，新增旧 Skill 的只读诊断及显式登记说明。即时线上快照、SHA256 并发核对、diff 审阅、备份和原子替换完成；13 个保留文件及 Nginx 配置未改。两个公开入口共 26 个文件下载与冻结 main 一致，官方安装器在独立前缀报告 `CLI installed. Version: 1.3.19`，实际 stdio 握手、35 项目录发现通过；公开分发一致性检查通过。
4. 官网备份为 `47.94.105.123:/usr/share/nginx/allproduct/guide-backup-shiliu-cli-1.3.19-20261026-194240`，指南 SHA256 为 `b73a73c5632073a1ee8e379d03581c19cf5314f3842a4194f5dbbc2886a7fb4c`。本机全局 CLI 已更新到 1.3.19；源码原目录安全快进，旧依赖的 4115 个文件已完整备份校验后再按锁文件安装，新依赖审计为 0。

客户更新 CLI 后仍须重连已有 MCP 进程；Skill 登记继续明确选择路径，不静默处理历史副本。生产 Java 后端不属于本次发布。

完整证据目录：`D:\program\.release\shiliu-cli-1.3.19-20261026-194240`。关键文件为 `registry-verification.json`、`public-audit.json`、`public-smoke.json`、`website-verification.json`、`public-installer.log`、`guide-published.json` 和 `original-deps-backup.json`。原生验收证据仍在此前候选目录 `native-1319/proof.json` 中；公开 tarball 与该候选完全一致。
