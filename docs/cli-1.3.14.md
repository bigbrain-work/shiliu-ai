# CLI 1.3.14 发布说明

Windows 系统凭据库使用短期 Node worker。旧版本没有子进程截止时间，worker 卡住会让凭据刷新、刷新锁及业务调用一直等待。本版本给 worker 增加默认 10 秒期限，超时或通信失败关闭输入并终止本次创建的精确 PID，不杀 shell 或进程树。

终止后优先等待 close，避免正常情况下在 worker 仍运行时释放刷新锁；退出确认最多再等 1 秒，系统拒绝终止时请求也不会永久挂住。所有路径只完成一次，清理计时器，晚到的 error/close 不造成未捕获异常。超时及 worker 失败不会输出 stdin、stdout 或原始 stderr；缺失凭据条目的原有 null/clear 语义保留。

超时报告 CREDENTIAL_UNAVAILABLE，不把它当 AUTH_EXPIRED，不清空凭据、不要求重新扫码、不自动重放本次 worker 操作。后续正常检查可恢复。超时不证明系统写入已经回滚，无法确认终止时也不保证 worker 已退出；以凭据库实际状态为准。

验证包含挂起 worker、半包 JSON、提前失败、spawn/stdin 错误及 error/close 竞争、晚到错误、计时器清理、真实合成挂起 Node PID 退出、刷新锁释放及单进程去重后恢复。所有故障注入均为合成 fixture，不访问生产凭据库，不调用生产刷新接口。公开包另按 Node 18.14.1 严格 engines 冷安装、audit 和 smoke 验收。

只修复 worker 生命周期。macOS/Linux 当前直接访问原生凭据库的路径不受此子进程期限保护；真实 Keychain/Secret Service 阻塞场景未验收。连接生命周期和 401 判断分别评审，不混入本版本；官网最低 CLI 版本仍为 1.3.12。

## 2026-10-16 公开包验收

源码提交 `15bdca117a3f7262c4a76da46157f9b4c122b9bb`，[发布工作流](https://github.com/bigbrain-work/shiliu-ai/actions/runs/38846478495)成功。全量 146 项测试及三项 CI 通过；公开包 38 个文件与发布提交逐字节一致，SHA512/SHA1匹配registry，tarball SHA256为 `c4534840763d6032c6c119da6f5d5a7f07f9ca57400c4bba61af0f1e276a3105`。

Node18.14.1/npm9.9.4下使用全新前缀与缓存严格engines安装成功，audit零告警，9项smoke和三个真实公开入口（--bogus、login --json --session bad、--agent mcp）均通过。官网最低版本仍1.3.12；指南正常流程不依赖本版修复的非法参数或防御性故障行为。此项公开包验收不替代真实客户端验收；真实Keychain/Secret Service故障仍未验。
