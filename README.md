# 石榴 AI Agent 工具

石榴 AI 面向 Agent 提供抖音与 TikTok 数据获取、视频文案提取、AI 媒体处理、任务管理等能力。

本仓库包含：

- `skills/shiliu-ai-mcp`：供 Codex、Claude Code 等 Agent 安装的机器可读 Skill。
- `npm/mcp-connect`：连接石榴 AI 远程 MCP 的跨平台命令行工具。

## 安装 Skill

公共仓库发布后可使用：

```bash
npx -y skills add bigbrain-work/shiliu-ai -a codex -y
```

将 `codex` 换成目标 Agent 名称，或按 `skills` CLI 的交互提示选择 Agent。

## 配置 MCP

CLI 默认启动微信扫码设备登录，换取短期访问令牌和可轮换刷新令牌。令牌保存在操作系统凭据库中，不会写入本仓库或 Agent 配置。

```bash
npx -y @bigbrain-work/mcp-connect login
npx -y @bigbrain-work/mcp-connect install
npx -y @bigbrain-work/mcp-connect status
npx -y @bigbrain-work/mcp-connect tools
```

也可使用短命令名 `shiliu`。现有 `mcp-connect` 命令保持兼容。

## 安全原则

- 不在命令参数、仓库、日志或 Agent 配置中保存真实凭据。
- 访问令牌过期前自动刷新；退出登录时撤销刷新令牌并清除本机凭据。
- 旧 API Key 仅作为迁移期兼容方式，需显式使用 `--legacy-api-key`。
- 工具清单和参数结构从 MCP 服务实时读取，Skill 不复制一份易过期的接口定义。
- 长耗时或计费操作仅在用户明确请求后执行，并避免重复提交任务。

## 当前阶段

Skill、CLI 与设备授权后台目前处于本地验收阶段。GitHub 公共仓库、网页安装入口、npm 正式发布和生产部署将在全部联调完成后统一上线。
