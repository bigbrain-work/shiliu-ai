# 石榴 AI Agent 工具

石榴 AI 面向 Agent 提供联网搜索、抖音与 TikTok 数据获取、视频文案提取、AI 媒体处理、任务管理等能力。

本仓库包含：

- `skills/shiliu-ai-mcp`：供 Codex、Claude Code 等 Agent 安装的机器可读 Skill。
- `npm/mcp-connect`：连接石榴 AI 远程 MCP 的跨平台命令行工具。

## 安装 Skill

Skill 与 CLI 独立、默认尝试，失败不影响远程 MCP 正常使用。Windows 无 CLI 时可使用官网
`install-skill.ps1`，从 `skill-files.json` 校验并安装，不要求 Node/npm。已有 CLI 时选择一条：

```text
shiliu skill install --agent codex --scope project --json
shiliu skill install --agent claude-code --scope project --json
shiliu skill install --agent cursor --scope user --json
```

以上 CLI 命令要求 Node >=18.14.1；远程 MCP 和独立 Skill 安装不要求它。仅选择当前客户端和所需 scope；其他客户端仅使用其文档规定的位置。

## 配置 MCP

默认远程 HTTP MCP，使用客户端 OAuth 打开石榴 AI 网页：已登录确认授权，未登录先网页登录再确认。
不以安装 CLI、Node/npm 或 Skill 为前提。完整固定流程见官网 `install.txt`、`onboarding.json`。
本分支为未发布的协同改造候选；后端、前端和静态指南需协调上线。

```bash
codex mcp add shiliu_mcp --url https://api.bigbrain.work/shiliu/mcp
codex mcp login shiliu_mcp
```

也可使用短命令名 `shiliu`。现有 `mcp-connect` 命令保持兼容。

桌面客户端没有 CLI 时使用其 MCP 设置填写远程地址并授权。通过原生 MCP 查询免费余额成功才报告安装完成；待重连不是失败。
MCP 成功后绝不获取 API Key。仅确认客户端接入失败时，另行网页确认读取已有 Key，优先安全凭据存储，否则使用 `connect-http.ps1` 配置用户环境变量。
旧版 `shiliu login --no-wait --json` 与 `shiliu install --transport stdio` 保留为显式兼容路径，不用于新默认流程。

## 安全原则

- 不在命令参数、仓库、日志或 Agent 配置中保存真实凭据。
- 访问令牌过期前自动刷新；退出登录时撤销刷新令牌并清除本机凭据。
- HTTP 备用使用已有 API Key，经单独确认后配置，不创建或重置 Key，不输出凭据。
- 工具清单和参数结构以 MCP 服务实时返回为准；复杂能力可在 Skill 中提供按需加载的使用说明。
- 长耗时或计费操作仅在用户明确请求后执行，并避免重复提交任务。

## 发布状态

- 公共仓库：`bigbrain-work/shiliu-ai`
- npm 版本以 `npm/mcp-connect/package.json` 和对应发布记录为准；源码修改不代表已发布。
- 机器可读安装指南：`https://bigbrain.work/shiliuAI/install.txt`
- Windows 安装问题与发布验收：`docs/windows-install-acceptance.md`
- CLI 与官网安装文件发布流程：`RELEASE_CLI.md`
- 各历史版本变更见 `docs/cli-<版本>.md`；1.4.0 已于 2026-10-28 发布，存量兼容修复候选为 1.4.1（未发布）。

## 更新边界

- MCP 工具名称、入参和出参以服务端实时 `tools/list` 为准，服务端更新后不要求用户重装 npm 包或 Skill。
- CLI 已可用时，每个任务最多运行一次 `shiliu skill refresh`；缺失或刷新失败不能阻塞 MCP 或触发安装。24 小时内或未登记目标正常跳过。
- 到期后只检查并更新 `shiliu-ai-mcp`，不会连带更新其他 Skill；成功或失败都会进入 24 小时冷却，网络故障不会拖慢之后的每次任务。

## 官网发布产物

本仓库的固定安装/备用脚本、状态契约和 `skills/shiliu-ai-mcp` 是官网分发内容的唯一源码。不要手工维护前端副本。发布前运行：

```text
node scripts/build-public-site-assets.mjs <网站项目的 public 目录>
node scripts/verify-skill-distribution.mjs <网站项目的 public/.well-known/agent-skills 目录>
```

构建脚本会复制安装文件、保留逐文件 Skill 访问路径，并生成符合 discovery 0.2.0 的扁平 `tar.gz`、SHA-256 摘要和 `index.json`。线上一致性检查由 `.github/workflows/public-consistency.yml` 定时执行。
