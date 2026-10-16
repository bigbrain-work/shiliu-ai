# CLI 1.3.13 发布说明

本版本仅修复 P2 第一项：普通 CLI 参数错误被 MCP 致命诊断覆盖，以及通过参数值误判 MCP 模式。已 rebase 到包含官网与升级通知的 main `fe8e1eb`，独立评审和发布，不改变 1.3.12 的发布内容。

`shiliu --bogus` 会保留 Node 参数解析器的具体错误；`shiliu login --json --session bad` 在 stderr 返回既有的 `{status, error, message}` 格式及具体中文提示，退出码为普通命令失败的 1，stdout 为空，不写 fatal 诊断日志。

MCP 模式根据命令位置识别，忽略字符串选项的值、工具名和 `--` 后的位置含义。例如 `--agent mcp`、`call proxy` 都是普通 CLI 调用；真正的 `mcp`/`proxy` 参数错误仍返回脱敏 `CONFIG_INVALID / argument_parse`、退出码 2。运行时依赖失败和内部异常的分类保持原样。

参数错误格式化不需要先加载 SDK、二维码或系统凭据库依赖。现有设备授权过期、拒绝和网络错误的 JSON 字段保持不变。

验证覆盖两个真实打包入口、错误消息和 JSON 契约、长短选项及选项值、子命令、参数终止符，以及真实 MCP 错误脱敏。已通过独立 PR 合入与发布，公开验收结果见下文。

凭据子进程超时、认证重试、连接生命周期及 repair 修复将分别处理，不包含在本版本中。

官网安装指南最低 CLI 版本继续保持 1.3.12：指南正常的安装、登录、诊断及 Skill 刷新流程不依赖非法参数时的报错格式。现有 1.3.12 用户无需仅为满足指南而升级到 1.3.13；依赖具体参数错误或 JSON 错误契约的自动化可升级到本版本。

## 2026-10-16 公开包验收

源码提交 `6f785b9358edf21b39c4a2d747bd19056da806a3`，[发布工作流](https://github.com/bigbrain-work/shiliu-ai/actions/runs/38844815432)成功。全量 136 项测试及三项 CI 通过；公开包 38 个文件与发布提交逐字节一致，SHA512/SHA1匹配registry，tarball SHA256为 `e991cb1fb7e2ec404602b328773b99f0c94cd3e2e22133c28179ddcde3e1fb7b`。

Node18.14.1/npm9.9.4下使用全新前缀与缓存严格engines安装成功，audit零告警，9项smoke和三个真实公开入口（--bogus、login --json --session bad、--agent mcp）均通过。官网最低版本仍1.3.12；指南正常流程不依赖本版修复的非法参数或防御性故障行为。此项公开包验收不替代真实客户端验收；真实Keychain/Secret Service故障仍未验。
