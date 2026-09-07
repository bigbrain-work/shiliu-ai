# @bigbrain-work/mcp-connect

石榴 AI 官方命令行工具。它负责验证当前凭据、配置常见 Agent、检查远程 MCP、读取实时工具清单，并为只支持 stdio 的客户端提供桥接。

## 命令

```bash
# 微信扫码登录；令牌进入操作系统凭据库
npx -y @bigbrain-work/mcp-connect login

# Agent/无头环境：先创建会话并立即返回，再按返回的 poll_command 继续
npx -y @bigbrain-work/mcp-connect login --no-wait --json
npx -y @bigbrain-work/mcp-connect login poll --session <会话号> --wait --json

# 自动检测并配置已安装的 Agent
npx -y @bigbrain-work/mcp-connect install

# 只配置一个 Agent
npx -y @bigbrain-work/mcp-connect install --agent codex

# 检查本地配置、远程连接和 tools/list
npx -y @bigbrain-work/mcp-connect status

# 显示服务实时返回的工具
npx -y @bigbrain-work/mcp-connect tools

# 撤销刷新令牌并清除本机凭据
npx -y @bigbrain-work/mcp-connect logout
```

安装后也可使用 `shiliu` 命令。原有 `mcp-connect` 命令保持兼容。

`--url` 和 `--auth-url` 默认只接受石榴 AI 正式服务地址。开发者如需连接
`127.0.0.1`、`localhost` 或 `::1` 上的测试服务，必须显式添加
`--allow-localhost`；该开关不会放行局域网或公网第三方地址。

## 通用 Agent

```bash
npx -y @bigbrain-work/mcp-connect install --agent openclaw
```

对未内置适配器的 Agent，CLI 会输出标准 stdio MCP 配置。名称只用于提示，不要求我们枚举所有 Agent。

## 凭据安全

- 不支持 `--api-key` 参数，避免密钥进入 shell 历史。
- 默认微信扫码后获得短期访问令牌；过期前使用可轮换刷新令牌自动更新。
- 令牌保存在 Windows Credential Manager、macOS Keychain 或 Linux Secret Service，不写入 Agent 的 MCP 配置。
- 登录后先以新访问令牌调用一次 `tools/list`，验证成功后才保存。
- 非阻塞登录只把设备码暂存在系统凭据库，JSON 输出不包含设备码或访问令牌。
- `status --json` 与 `tools --json` 不输出任何令牌。

迁移期如确需使用现有 API Key，可显式运行 `login --legacy-api-key`；此入口将在设备登录稳定后移除。
