# CLI 1.3.16 发布说明

修复 repair 中断后残留锁阻止同一缓存下所有 MCP 启动的问题。stdio 预检只在 PID 存活或无法确认时阻止启动；只有 ESRCH 才证明旧进程已退出。预检不删除锁。缺失/损坏 PID、权限不足、PID 被复用均保守阻止，并提示核对修复进程，不再泛化为重新安装 CLI。

显式 repair 以已有 proper-lockfile 依赖的独立 guard 串行化锁接管，再重读并清理确认已退出的旧 owner。guard 带心跳及10秒陈旧阈值，异常退出后的下一次 repair 最多需等待该窗口。结束时只释放本次 probe_id 的锁，不删除其他修复者的锁；预检仅用 Node 内建模块，不依赖 SDK 或 guard 包。

PowerShell 5.1 进程清单在输出前显式设置 UTF-8，避免中文用户名/缓存路径乱码后遗漏活动进程。保留精确缓存边界、活动 MCP 检查、备份和双重握手。测试覆盖死/活/未知PID、损坏记录、竞争、真实退出进程及 Windows 中文路径活动进程，不操作用户真实缓存或凭据。

限制：未知锁内容不自动删除；无法确认 PID 身份时不冒险接管。stdio 能启动不表示损坏依赖已恢复。依赖版本及官网最低版本1.3.12保持不变。连接生命周期按独立设计实施，不混入本版。

## 2026-10-16 公开包验收

源码提交 `41d2aee64bafde4c0d20080683bd60e9ef5edd7c`，[发布工作流](https://github.com/bigbrain-work/shiliu-ai/actions/runs/38848375330)成功。全量 156 项测试及三项 CI 通过；公开包 39 个文件与发布提交逐字节一致，SHA512/SHA1匹配registry，tarball SHA256为 `6972cc0010262e825a36d11a9715515205cddb91b90bbc638faf31043d357e3d`。

Node18.14.1/npm9.9.4下使用全新前缀与缓存严格engines安装成功，audit零告警，9项smoke和三个真实公开入口（--bogus、login --json --session bad、--agent mcp）均通过。官网最低版本仍1.3.12；指南正常流程不依赖本版修复的非法参数或防御性故障行为。此项公开包验收不替代真实客户端验收；真实Keychain/Secret Service故障仍未验。
