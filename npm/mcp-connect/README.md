# @bigbrain-work/mcp-connect

石榴 AI 官方命令行工具。它负责验证当前凭据、配置常见 Agent、检查远程 MCP、读取实时工具清单，并为只支持 stdio 的客户端提供桥接。

## 命令

```bash
# 当前兼容授权（隐藏输入，不把密钥放进命令参数）
npx -y @bigbrain-work/mcp-connect login

# 自动检测并配置已安装的 Agent
npx -y @bigbrain-work/mcp-connect install

# 只配置一个 Agent
npx -y @bigbrain-work/mcp-connect install --agent codex

# 检查本地配置、远程连接和 tools/list
npx -y @bigbrain-work/mcp-connect status

# 显示服务实时返回的工具
npx -y @bigbrain-work/mcp-connect tools

# 清除本机当前兼容凭据
npx -y @bigbrain-work/mcp-connect logout
```

安装后也可使用 `shiliu` 命令。原有 `mcp-connect` 命令保持兼容。

## 通用 Agent

```bash
npx -y @bigbrain-work/mcp-connect install --agent openclaw
```

对未内置适配器的 Agent，CLI 会输出标准 stdio MCP 配置。名称只用于提示，不要求我们枚举所有 Agent。

## 凭据安全

- 不支持 `--api-key` 参数，避免密钥进入 shell 历史。
- 不将真实密钥写入 Agent 的 MCP 配置。
- `status --json` 与 `tools --json` 不输出密钥。

目前 `login` 沿用 API Key 兼容流程。设备码授权完成后会在保持命令不变的前提下替换底层授权实现。
