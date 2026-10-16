# CLI 1.3.15 发布说明

旧版通过错误消息中的 401、Unauthorized 或 token invalid/expired 判断平台登录失效。业务接口返回类似文字时，代理可能重连并再次执行工具。本版本只接受 SDK 的明确认证/HTTP 错误类型或数值 HTTP status=401，不再根据消息文字、普通 code=401 或错误名称推断认证失败。

JSON-RPC 错误先被排除，包括 -32603、业务自定义正数 401 及带下游 HTTP401 cause 的错误。明确非401的 HTTP 错误不沿 cause 误判；cause 遍历有界。正常 isError 结果原样返回。只有确认平台 HTTP401 时保留原有的一次凭据重读、重连和恢复，不在此版本改连接生命周期。

验证使用实际 SDK 和本地 HTTP MCP fixture：带401/token文字的两种 JSON-RPC 错误只执行一次、不重连；isError 结果不重放；在业务派发前返回的真实HTTP401恢复一次，两个请求但业务仅执行一次。没有调用生产付费工具或刷新接口。

限制：HTTP401本身不能证明远端没有执行操作。包括401在内禁止自动重放 callTool 的整体策略属于下一项连接生命周期设计，须另行复核后实现。本版本不声称消除所有重试重复执行风险。依赖及官网最低版本1.3.12不变；公开包已完成严格 engines 冷安装、audit 和 smoke 验收。

## 2026-10-16 公开包验收

源码提交 `91a854e9e3579e0b4b4ed4234771ee4cb6741020`，[发布工作流](https://github.com/bigbrain-work/shiliu-ai/actions/runs/38847349745)成功。全量 151 项测试及三项 CI 通过；公开包 38 个文件与发布提交逐字节一致，SHA512/SHA1匹配registry，tarball SHA256为 `f75f8090a74b635061ee7f76642fdc5445385770f693937a06d0d355e7ca752c`。

Node18.14.1/npm9.9.4下使用全新前缀与缓存严格engines安装成功，audit零告警，9项smoke和三个真实公开入口（--bogus、login --json --session bad、--agent mcp）均通过。官网最低版本仍1.3.12；指南正常流程不依赖本版修复的非法参数或防御性故障行为。此项公开包验收不替代真实客户端验收；真实Keychain/Secret Service故障仍未验。
