# 石榴 AI Agent 工具

石榴 AI 面向 Agent 提供联网搜索、抖音与 TikTok 数据获取、视频文案提取、AI 媒体处理、任务管理等能力。

本仓库包含：

- `skills/shiliu-ai-mcp`：供 Codex、Claude Code 等 Agent 安装的机器可读 Skill。
- `npm/mcp-connect`：连接石榴 AI 远程 MCP 的跨平台命令行工具。

## 安装 Skill

先按 https://bigbrain.work/shiliuAI/install.txt 安装或升级官方 CLI，再运行一次当前客户端对应的命令：

```text
shiliu skill install --agent codex --scope project --json
shiliu skill install --agent claude-code --scope project --json
shiliu skill install --agent cursor --scope user --json
```

三个内置客户端均从官网 HTTPS 索引下载并校验 Skill 归档，不调用外部 skills CLI，不依赖 Git、GitHub 或外部 Skill 安装器。完整 CLI/Skill 流程最低 Node.js 18.14.1，推荐 Node.js 24 LTS。只选择当前客户端和所需 scope 执行一条命令。其他客户端使用显式 `--target-dir`。

## 配置 MCP

CLI 默认启动微信扫码设备登录，换取短期访问令牌和可轮换刷新令牌。令牌保存在操作系统凭据库中，不会写入本仓库或 Agent 配置。

```bash
npx -y @bigbrain-work/mcp-connect@latest login
npx -y @bigbrain-work/mcp-connect@latest install
npx -y @bigbrain-work/mcp-connect@latest status
npx -y @bigbrain-work/mcp-connect@latest tools
```

也可使用短命令名 `shiliu`。现有 `mcp-connect` 命令保持兼容。

Agent 或其他非阻塞环境应运行 `shiliu login --no-wait --json`。二维码已经由 CLI 生成，Agent 只需把返回的 `qr_code_path` 本地 PNG 直接展示给用户，然后立即按照 `poll_after_seconds` 重复执行单次 `poll_command`。用户只需微信扫码，手机端没有确认按钮，Agent 不等待用户回复。`verification_uri` 不应作为普通网页直接打开。授权结束或过期后，CLI 会清理临时二维码图片。

## 安全原则

- 不在命令参数、仓库、日志或 Agent 配置中保存真实凭据。
- 访问令牌过期前自动刷新；退出登录时撤销刷新令牌并清除本机凭据。
- 旧 API Key 仅作为迁移期兼容方式，需显式使用 `--legacy-api-key`。
- 工具清单和参数结构以 MCP 服务实时返回为准；复杂能力可在 Skill 中提供按需加载的使用说明。
- 长耗时或计费操作仅在用户明确请求后执行，并避免重复提交任务。

## 发布状态

- 公共仓库：`bigbrain-work/shiliu-ai`
- npm：`@bigbrain-work/mcp-connect@1.3.10`
- 机器可读安装指南：`https://bigbrain.work/shiliuAI/install.txt`
- Windows 安装问题与发布验收：`docs/windows-install-acceptance.md`
- CLI 与官网安装文件发布流程：`RELEASE_CLI.md`
- 各版本变更和发布结果统一记录在 `docs/cli-<版本>.md`；当前本地候选：[CLI 1.3.12](docs/cli-1.3.12.md)。通用发布流程不重复维护版本说明。

## 更新边界

- MCP 工具名称、入参和出参以服务端实时 `tools/list` 为准，服务端更新后不要求用户重装 npm 包或 Skill。
- 每个用户任务首次调用石榴 MCP 前运行一次 `shiliu skill refresh`；CLI 按项目记录检查时间，24 小时内立即跳过。未登记或路径缺失时正常跳过，不安装到新项目；旧用户必须更新全局 CLI，不能只重连 npx 代理。
- 到期后只检查并更新 `shiliu-ai-mcp`，不会连带更新其他 Skill；成功或失败都会进入 24 小时冷却，网络故障不会拖慢之后的每次任务。

## 官网发布产物

本仓库根目录的三个安装文件和 `skills/shiliu-ai-mcp` 是官网分发内容的唯一源码。不要直接手工维护前端仓库里的副本。发布网站前运行：

```text
node scripts/build-public-site-assets.mjs <网站项目的 public 目录>
node scripts/verify-skill-distribution.mjs <网站项目的 public/.well-known/agent-skills 目录>
```

构建脚本会复制安装文件、保留逐文件 Skill 访问路径，并生成符合 discovery 0.2.0 的扁平 `tar.gz`、SHA-256 摘要和 `index.json`。线上一致性检查由 `.github/workflows/public-consistency.yml` 定时执行。
