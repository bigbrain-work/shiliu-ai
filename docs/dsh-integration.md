# DeepSeek Harness（DSH）接入评估

核对日期：2026-10-30。依据当前源码、公开 npm 1.4.1 和 DSH 官方文档/源码；尚未在 DSH 内执行连接或业务验收。

## 结论与现有能力

现有公开仓库和 npm 包具备通过标准 MCP 接入 DSH 的基础，不需要另建业务后端或重写工具。安装流程改为默认远程 OAuth，没有移除 `@bigbrain-work/mcp-connect mcp` 的 stdio 服务。

| 目标 | 当前情况 | 还需完成 |
| --- | --- | --- |
| 手动配置 MCP 使用石榴工具 | DSH 内置 `@deepseek-ai/dsh-mcp-client` 支持 stdio；现有包提供 stdio、扫码登录工具、业务工具发现及列表变更通知 | DSH 配置及原生验收 |
| 只填远程地址并打开网页 OAuth | DSH 通用 HTTP 传输目前仅传入 URL 和 headers，未配置浏览器 OAuth 授权提供方 | 核实目标 DSH 版本的授权入口；不能直接套用 Codex 的 OAuth 操作 |
| 通过 DSH“安装插件”直接启用 | 现有 npm 包没有 `dsh.bundle` 和 Cordis patch；CLI 自动配置仅识别 Codex、Claude、Cursor | 补充 DSH 组合包及安装说明，并验收 |

## 优先验证 stdio

在独立的 DSH 测试配置中引用内置 MCP 客户端，设置唯一的 `id` / `serverName`，以 stdio 启动已发布的 `@bigbrain-work/mcp-connect@1.4.1 mcp`。Windows 应使用经过验证的 `cmd /d /s /c npx ...` 或绝对 Node 入口；不要把 PowerShell 包装脚本直接当作双向 stdio 服务。

首次安装需要可用的 Node/npm；扫码及凭据存储由现有连接器处理。DSH 会清洗继承环境中的凭据变量，不能依赖自动继承 API Key。不得在共享配置或插件包中硬编码凭据。

原生验收应覆盖：握手与登录工具发现、二维码展示、扫码成功后业务工具自动刷新、免费余额返回零扣费、重启后凭据复用，以及退出后子进程结束。涉及长任务时单独核对 DSH 的 `toolCallTimeoutMs`（默认 60 秒），超时后不得自动重放可能扣费的请求。

## 如需分发为 DSH 插件

可在现有 `bigbrain-work/shiliu-ai` 仓库增加独立 npm 子包，声明 `dsh.bundle.patch` 并提供 `cordis.patch.yml`，复用内置 MCP 客户端与现有连接器。无需重写每个业务工具。直接执行 `dsh plugin add @bigbrain-work/mcp-connect` 只会将现有包作为普通依赖安装，不能自动启用石榴 MCP 配置。

完成目标版本、Windows 启动、登录与免费余额验收后，再发布该适配包。本次仅记录评估，没有创建适配包、安装 DSH 或改变任何客户端配置。

## 官方依据

- [通用 MCP 配置](https://deepseek-harness.github.io/deepseek-harness/guide/mcp-memory#接入其他-mcp-服务器)
- [MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)
- [HTTP / stdio 传输实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/src/transport.ts)
- [DSH 组合包与安装规则](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
