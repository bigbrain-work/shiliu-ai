# CLI 1.4.1 存量用户兼容修复

状态：本地候选，未发布 npm，未同步官网。

## 背景

1.4.0 与新版官网指南把默认接入方式改为远程 MCP + 浏览器 OAuth。验收发现几条路径会把已经可用的 stdio 桥接用户切换为 OAuth，相当于要求重新安装：

- `shiliu install`（以及不带参数的 `shiliu`、旧文档中的 `npx -y @bigbrain-work/mcp-connect@latest install`）默认 http，遇到同名条目会删除原 stdio 配置后改写。
- `codex mcp add` 遇到同名条目不报错，直接覆盖；新版指南和 `connect-mcp.ps1` 都在未检查的情况下执行它。
- `connect-mcp.ps1` 对 Claude 已有条目返回 `configuration_failed`，该状态允许进入 HTTP 备用领取 API Key。
- `recovery.txt` 引用的 Step 2/4/5 在新版 install.txt 中已改为其他内容。

## 修改内容

- `shiliu install` 未显式指定 `--transport` 时，已有 `shiliu_mcp` 条目（stdio 或远程、配置无法解析也算）一律保留，返回 `existing_preserved`。客户端 CLI 不在 PATH 但配置文件存在时同样保留。本机已有 stdio 条目时，为其他客户端新增的条目也沿用 stdio（共享原 CLI 登录），与旧版行为一致。显式 `--transport` 仍按用户选择执行。JSON 输出增加 `legacy_stdio_present`。
- `connect-mcp.ps1` 先用 `codex/claude mcp get` 与配置文件检查已有条目，存在时返回 `existing_installation`，不执行 add。
- `install.ps1` / `install.sh` 检测到已有 stdio 条目时，恢复原来的 `doctor --transport stdio --standard-only --prepare` 验证和提示，不切换、不登录。最低 CLI 版本 1.4.1。
- 发布前的旧版指南原样保留为 `install-stdio.txt`（仅修改标题、规范地址，并对 `shiliu install` 显式加 `--transport stdio`）。`recovery.txt` 的步骤引用全部指向该文件。
- `install.txt` 增加第 0 节“已有安装检查”；`onboarding.json` 增加 `existing_installation`（不可进入 HTTP 备用）；Skill `references/installation.md` 开头同步。

## 验证

- CLI 全量 222 项测试通过，含新增存量兼容 7 项（全部使用 `--dry-run` 与临时 HOME）。
- Windows 安装器行为测试（含存量 stdio 分支）、固定脚本测试、POSIX 安装器语法检查通过。
- `connect-mcp.ps1`：临时 `CODEX_HOME` 新用户正常配置、二次运行返回 `existing_installation`；本机真实 Codex/Claude stdio 条目返回 `existing_installation` 且配置字节不变。
