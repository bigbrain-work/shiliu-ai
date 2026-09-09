# 石榴 AI Agent 工具

石榴 AI 面向 Agent 提供抖音与 TikTok 数据获取、视频文案提取、AI 媒体处理、任务管理等能力。

本仓库包含：

- `skills/shiliu-ai-mcp`：供 Codex、Claude Code 等 Agent 安装的机器可读 Skill。
- `npm/mcp-connect`：连接石榴 AI 远程 MCP 的跨平台命令行工具。

## 安装 Skill

可以直接使用：

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

Agent 或其他非阻塞环境应运行 `shiliu login --no-wait --json`。二维码已经由 CLI 生成，Agent 只需把返回的 `qr_code_path` 本地 PNG 直接展示给用户使用微信扫码，不需要自行把链接转成二维码。`verification_uri` 是二维码载荷和排障备用地址，不应作为普通网页直接打开。授权结束或过期后，CLI 会清理临时二维码图片。

## 安全原则

- 不在命令参数、仓库、日志或 Agent 配置中保存真实凭据。
- 访问令牌过期前自动刷新；退出登录时撤销刷新令牌并清除本机凭据。
- 旧 API Key 仅作为迁移期兼容方式，需显式使用 `--legacy-api-key`。
- 工具清单和参数结构从 MCP 服务实时读取，Skill 不复制一份易过期的接口定义。
- 长耗时或计费操作仅在用户明确请求后执行，并避免重复提交任务。

## 发布状态

- 公共仓库：`bigbrain-work/shiliu-ai`
- npm：`@bigbrain-work/mcp-connect@1.3.2`
- 机器可读安装指南：`https://bigbrain.work/shiliuAI/install.txt`

## 更新边界

- MCP 工具名称、入参和出参以服务端实时 `tools/list` 为准，服务端更新后不要求用户重装 npm 包或 Skill。
- 每个用户任务首次调用石榴 MCP 前运行一次 `shiliu skill refresh`；CLI 按项目记录检查时间，24 小时内立即跳过。
- 到期后只检查并更新 `shiliu-ai-mcp`，不会连带更新其他 Skill；成功或失败都会进入 24 小时冷却，网络故障不会拖慢之后的每次任务。
