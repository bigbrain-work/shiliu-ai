# @bigbrain-work/mcp-connect

石榴 AI 官方命令行工具。它负责验证当前凭据、配置常见 Agent、检查远程 MCP、读取实时工具清单，并为只支持 stdio 的客户端提供桥接。

## 命令

```bash
# 微信扫码登录；令牌进入操作系统凭据库
npx -y @bigbrain-work/mcp-connect login

# Agent/无头环境：展示二维码后立即按返回间隔短轮询，不等待用户回复
npx -y @bigbrain-work/mcp-connect login --no-wait --json
npx -y @bigbrain-work/mcp-connect login poll --session <会话号> --json

# 自动检测并配置已安装的 Agent
npx -y @bigbrain-work/mcp-connect install

# 只配置一个 Agent
npx -y @bigbrain-work/mcp-connect install --agent codex

# 检查本地配置、远程连接和 tools/list
npx -y @bigbrain-work/mcp-connect status

# 显示服务实时返回的工具
npx -y @bigbrain-work/mcp-connect tools

# 诊断本机 stdio 启动条件，并实际完成一次 MCP 握手和 tools/list
npx -y @bigbrain-work/mcp-connect doctor

# 只检查运行时和候选配置，不启动 MCP
npx -y @bigbrain-work/mcp-connect doctor --dry-run --json

# 使用实时工具目录校验参数后调用工具
shiliu call <工具名> --args-file <参数.json>

# 大响应可选写入文件；默认不覆盖，显式 --force 才允许覆盖
shiliu call <工具名> --args-file <参数.json> --out <结果.json>

# 每个项目最多每24小时从石榴官网定向刷新一次石榴 Skill
shiliu skill refresh

# 首次安装时记录准确的客户端和范围，后续 refresh 复用该目标
shiliu skill install --agent codex --scope project
shiliu skill install --agent claude-code --scope user

# 人工忽略冷却并立即重试
shiliu skill refresh --force

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

对未内置适配器的 Agent，CLI 会输出标准 stdio MCP 配置和本机诊断结果。名称只用于提示，不要求我们枚举所有 Agent。标准 `npx` 配置始终是首选；当当前或持久 PATH 不可靠时，CLI 才额外提供绝对路径备选，并明确提示版本固定和应用升级后路径失效等代价，不会静默替换配置。

Windows 上请使用 CLI 生成的 `cmd /d /s /c npx ... mcp` 配置，不要把 npm 自动生成的 `shiliu.ps1 mcp` 注册为 MCP command；PowerShell 包装器不适合作为长期双向 stdio 通道。MCP 进程遇到登录令牌过期或用户重新扫码后返回的 401，会自动重读系统凭据并重连一次，无需把令牌写入 Agent 配置。

### 先连接，再登录

本地 MCP 桥接进程现在先完成 `initialize`，不在握手前读取凭据或等待远程网络。未登录时，`tools/list` 返回 `shiliu_login`、`shiliu_login_poll`、`shiliu_connection_status` 三个基础工具，Agent 可以先建立连接，再展示微信二维码并按返回间隔短轮询。扫码后仍须轮询领取并保存凭据；手机显示扫码成功不等于电脑端登录完成。

登录成功后，桥接读取本机系统凭据并连接远程服务，加入服务端实时返回的业务工具，发送 `notifications/tools/list_changed`。也兼容在外部终端执行 `shiliu login`，运行中的桥接每 5 秒检查登录变化。客户端若不响应工具列表变更通知，需要刷新工具或重新连接。

未登录、凭据不可读或远程暂时不可达时，基础工具与 MCP 连接保持可用；业务调用返回明确的登录或连接提示。`doctor` 区分本地 MCP 握手成功与远程业务连接成功，三个基础工具不计入业务工具数量。`shiliu status` 和 `shiliu tools` 继续验证已登录的远程服务。

此流程适用于 CLI 提供的本地 stdio 桥接。直接 HTTP MCP 地址仍要求登录凭据，服务端业务接口的鉴权和计费规则保持不变。

### 错误分类与诊断日志

MCP 无法继续运行时，进程退出码区分为：`2` 配置/参数错误（`CONFIG_INVALID`）、`3` Node 版本或依赖不可用（`RUNTIME_UNAVAILABLE`）、`4` 未处理的内部异常（`INTERNAL_ERROR`）；正常关闭为 `0`。两个 CLI 入口均可捕获依赖加载失败，启动后未处理的异常也会输出诊断。

未登录、凭据失效、凭据库不可读和远程暂时不可达分别返回 `LOGIN_REQUIRED`、`AUTH_EXPIRED`、`CREDENTIAL_UNAVAILABLE`、`REMOTE_UNAVAILABLE`，保持 MCP 连接。工具结果含 `code`、`stage`、`message`、`action`；`shiliu_connection_status` 额外返回诊断路径和 `diagnostic_log_available`。诊断只在状态/错误分类变化时记录，避免轮询重复刷日志。

诊断输出为 stderr 上的一行 JSON，并保存在当前系统用户的 `~/.shiliu-ai/logs/mcp-diagnostics.jsonl`。日志到 512 KiB 时轮换，保留一份 `.1` 备份。错误记录只包含固定的安全说明、时间、阶段、进程 ID 和诊断路径，不包含原始异常、堆栈、命令参数、环境变量、请求内容、URL 或凭据。日志写入失败不影响 MCP 连接；请以 `diagnostic_log_available` 判断文件是否成功写入。

`doctor` 失败结果增加 `error_code`、`error_stage`、`process_exit_code`，优先使用连接程序的结构化诊断，避免仅显示 `Connection closed`；未能捕获子进程退出信息时 `process_exit_code` 为 `null`。第三方原始 stderr 不会直接写入报告。客户端仍可能只展示通用断开提示；Agent 可读取上述本地诊断日志继续排查。若 Node 根本无法启动，或进程被系统强制终止，连接程序无法保证产生日志。

`doctor` 只能验证当前机器上的运行时和 stdio 启动链路，不能证明某个 Agent 已经保存、重载或连接 MCP。安装验收应由当前 Agent 通过其原生 MCP 连接调用一次免费的 `get_account_balance`；通过 `shiliu call` 调用只能验证 CLI。`call --dry-run` 只读取实时工具目录并校验参数结构，不执行服务端业务调用。`call --out` 成功时会返回绝对路径、字节数和 SHA-256；写入失败不会留下半成品文件。

## 凭据安全

- 不支持 `--api-key` 参数，避免密钥进入 shell 历史。
- 默认微信扫码后获得短期访问令牌；过期前使用可轮换刷新令牌自动更新。
- 令牌保存在 Windows Credential Manager、macOS Keychain 或 Linux Secret Service，不写入 Agent 的 MCP 配置。
- 登录后先以新访问令牌调用一次 `tools/list`，验证成功后才保存。
- 非阻塞登录只把设备码暂存在系统凭据库，JSON 输出不包含设备码或访问令牌。
- `status --json` 与 `tools --json` 不输出任何令牌。

迁移期如确需使用现有 API Key，可显式运行 `login --legacy-api-key`；此入口将在设备登录稳定后移除。
