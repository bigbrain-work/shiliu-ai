# Windows 安装验收与问题台账

本文档记录石榴 AI CLI 在 Windows 上的真实安装问题、修复方式和发布门槛。新增安装能力或修改认证流程时，必须同步更新本文档和自动化测试。

## 支持基线

- Windows 10 或 Windows 11
- PowerShell 5.1 或 PowerShell 7
- Node.js 18 及以上，推荐 Node.js 22 LTS
- npm 8 及以上
- Codex、Claude Code 或 Cursor；也可以输出供其他 Agent 使用的标准 stdio MCP 配置

机器没有 Node.js 或 npm 时，安装指南必须明确引导用户安装 Node.js 22 LTS 官方安装包，并说明安装包自带 npm。npm 版本低于 8 时，安装脚本自动升级到兼容 Node.js 18 的 `npm@9.9.4`，升级后必须重新读取并校验版本。

## 2026-09-09 实机问题记录

| 问题 | 根因 | 修复 | 回归要求 |
| --- | --- | --- | --- |
| Agent 把微信授权链接当普通网页打开，页面无法完成授权 | 非阻塞登录只返回了链接，Agent 不一定具备二维码生成能力 | CLI 直接生成临时 PNG，并在 JSON 中返回 `qr_code_path`；指南要求 Agent 展示该文件 | 扫码成功；登录完成、拒绝或过期后删除 PNG；JSON 不包含令牌或内部设备码 |
| npm `latest` 刚发布时仍安装到旧版本 | npm dist-tag 和缓存传播存在短暂延迟 | 安装统一使用 `@latest --prefer-online`；发布验收先等待公开 `dist-tags.latest` 更新 | 公共安装脚本执行后，`shiliu --version` 与 npm `latest` 一致 |
| npm 包为 1.3.2，但 CLI 显示 1.3.1 | CLI 版本号被硬编码 | CLI 从自身 `package.json` 读取版本 | 单测必须断言 CLI 与包元数据版本一致 |
| Windows 执行 `shiliu skill refresh` 报 `spawnSync npx.cmd EINVAL` | Node.js 在 Windows 下不能可靠地以 `shell: false` 直接启动 npm 的 `.cmd` shim | 通过 `%ComSpec% /d /s /c` 启动固定的 `npx.cmd` 命令 | Windows 单测验证命令和参数；Skill 刷新失败仍进入冷却且不阻塞 MCP 调用 |
| Windows 自动识别 Agent 可能遇到同类 `.cmd` 启动失败 | `codex`、`claude` 等全局 npm 命令也是 `.cmd` shim | Windows 命令探测统一通过 `%ComSpec%`，并先限制命令名字符集 | Windows 单测覆盖正常探测和命令注入拒绝 |
| 已存在的 Codex 配置错误会让 `shiliu install --agent codex` 失败 | Codex 在读取自身 `config.toml` 时先校验全部字段；本机旧值 `service_tier = "default"` 已不被当前客户端接受 | 修正本机已有无效字段；石榴安装器不擅自修改与 MCP 无关的用户配置 | 安装失败时保留原始 Codex 错误；修复用户配置后可重复执行安装 |
| `shiliu logout` 后进程仍显示旧 API Key 登录 | 启动 Agent 的宿主进程注入了迁移期 `SHILIU_AI_API_KEY`，不是凭据库残留 | 验收设备登录时只在测试进程移除该环境变量；不把凭据写入命令或配置 | `status` 显示 `credentialSource=device`，Agent MCP 配置不含访问令牌 |
| 客户机器没有 npm 或 npm 过旧 | 原流程默认 npm 可用 | 缺失时给出 Node.js 22 LTS 官方安装指引；过旧时自动升级兼容版本 | PowerShell 和 shell 安装脚本均检查 Node/npm，升级失败或升级后仍过旧时明确终止 |
| npm 发布需要 Passkey 批准 | npm 账号的发布安全策略 | 发布者在浏览器批准；这不属于客户安装步骤 | 不向用户索要 OTP，不把发布凭据写入命令、日志或仓库 |
| 覆盖升级时 npm 报原生凭据库 DLL 的 `EPERM cleanup` 警告 | 正在运行的 Agent/MCP 进程仍占用旧版本的 Windows 原生 DLL，Windows 不允许立即删除 | 安装退出码为 0 且新版本正确时不判为失败；关闭正在运行的 Agent 后再更新可避免占用 | 升级后必须以 `shiliu --version` 和 `shiliu status` 判断结果，不能只看到 warning 就认定失败 |

## Windows 发布门槛

每个 PR 必须在 `windows-latest` 上完成以下检查：

1. PowerShell 解析 `install.ps1` 无错误。
2. 使用公开安装脚本安装当前 npm `latest`，验证真实网络安装入口没有失效。
3. 在 Windows 上运行全部 Node.js 单元测试和 npm 打包检查。
4. 安装当前分支生成的 tarball，断言 `shiliu --version` 与 `package.json` 一致。
5. 执行 `shiliu login --dry-run --json` 和 `shiliu install --agent codex --dry-run`，确认登录与 Windows stdio 配置命令可生成。
6. 使用 `skills` CLI 发现仓库内公开 Skill。

## 人工端到端验收

正式发布后从匿名访问的 `https://bigbrain.work/shiliuAI/install.txt` 开始，不使用本地仓库内容推断步骤：

1. 检查 Node.js 和 npm；缺失或过旧时走指南规定的分支。
2. 执行公开 PowerShell 安装脚本，确认安装的是已传播完成的 npm `latest`。
3. 安装 `shiliu-ai-mcp` Skill。
4. Agent 执行 `shiliu login --no-wait --json`，直接展示 `qr_code_path` 指向的 PNG。
5. 用户微信扫码批准后，执行返回的原样 `poll_command`。
6. 执行 `shiliu install --agent codex`，确认配置中只有本地 stdio 桥接，不包含令牌。
7. 在测试进程不使用迁移期旧 API Key 的条件下执行 `shiliu status --json`，必须显示设备凭据和远程连接成功。
8. 执行 `shiliu tools --json`，必须读取实时工具清单，而不是静态内置列表。
9. 确认登录二维码临时文件已清理。

Windows 覆盖升级如果出现 `EPERM cleanup`，先检查安装命令的退出码和 `shiliu --version`。版本已经更新且 `status` 正常时，警告仅表示旧临时目录暂时被进程占用；版本未更新时，应关闭所有正在使用石榴 MCP 的 Agent，再运行一次安装脚本。

真实扫码、凭据库和第三方客户端配置不能只靠单元测试代替；每个涉及这些路径的发布都应完成一次人工端到端验收。
