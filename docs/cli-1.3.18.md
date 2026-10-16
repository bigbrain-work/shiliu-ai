# CLI 1.3.18

本版集中处理 P2 复核的小问题和后续 P3 项目；中间不发布 npm 版本。生命周期仍沿用已验收的 1.3.17：工具调用不自动重放、120 秒空闲期限、15 分钟总期限、换令牌时排空在途请求。

## 修复内容

1. 凭据轮换后立即保留新令牌。系统凭据库写入使用 60 秒期限并重试一次，失败时在当前进程内保留、后续重试持久化；不会再次使用已消费的旧 refresh token。轮换后的核对读取失败也不会丢掉新令牌；补写前检查其他进程的退出/重新登录。登录写入超时同样重试并明确报告未持久化。
2. 新 repair 锁记录操作系统进程启动标识和创建时间，识别 PID 复用；超过 60 秒的空锁可在互斥保护下回收。旧版缺少启动标识且 PID 仍存活的锁继续保守处理。Windows CI 保留实际中文路径 Node 进程与 PowerShell 5.1 的匹配测试。
3. 参数扫描与严格解析对单独 `-` 作为选项值的行为一致。参数错误固定为 `command_failed`；网络错误只由结构化 name/code/cause 判断，不由用户输入的文本触发。
4. 二维码改用随机私有目录和排他创建文件；读取时校验目录、属主、链接和文件大小，不使用共享的固定 `/tmp/shiliu-ai`。旧会话中的不可信二维码路径重新生成，保留同一设备会话。
5. 识别 Volta/asdf 的 `../lib/node_modules/npm/bin/npm-cli.js` 布局；预热找不到 npm-cli 时沿目标环境回退 npx。
6. 登录等待对网络抖动和暂时 5xx 有限重试，遵循 `retry_after_seconds`，睡眠后重新检查截止时间。交互式二维码支持 `verification_uri_complete` 回退。设备码兑换后的验证/保存失败清除待处理会话。并发登录创建和轮询使用操作系统用户级互斥锁。
7. `invalid_grant` 时 status 显示需要重新登录，install 引导重新登录。`logout --force` 只清除本地凭据，明确提示远端令牌未撤销。dry-run 不触发凭据刷新、凭据写入或目录创建。
8. Windows 客户端配置通过跨平台进程适配器解析 pnpm/yarn 的 `.cmd` 和 PATHEXT，保留 JSON 参数；精确识别重复配置，避免误判 `does not exist`。remove/add 失败恢复原配置文件字节。status 解析 JSON/TOML 的目标服务器结构，并遵循 `CODEX_HOME`。
9. Skill 下载校验重定向最终 URL 的 HTTPS 和同源约束，读取流时限制 5 MiB。采用官网规范终点 `https://www.bigbrain.work/shiliuai`，不依赖跨源跳转。刷新锁回收在额外互斥内执行，释放前核对唯一持有标识；备份清理失败明确报告保留路径。
10. `call --out --force` 临时文件写完后原子替换，替换失败保留原文件；未授权覆盖时用排他的硬链接发布结果，防止并发创建的文件被覆盖。
11. 复验同一令牌连接的工具增删通知、完整分页更新以及不完整目录保留；CLI 调用使用 `readAllTools`。没有再次改写连接生命周期。
12. POSIX 安装器主体包装为函数、最后一行才执行；EACCES 提供用户级 npm prefix/PATH 指引。Windows 安装器统一保护原生命令 stderr，并以退出码判定成功。构建脚本支持 `--help`、拒绝以 `-` 开头的输出参数。
13. 版本比较按 semver 的预发布标识规则处理数字和文本，忽略构建元数据。参数模块在 Node 版本门槛之后动态加载，Node 16 返回明确的 18.14.1 最低版本提示。
14. POSIX profile 清理仅移除 CLI 写入的精确 source 行。Windows 保存前检查凭据长度，超限给出明确错误，不悄悄落到明文文件。Windows 限制依据：[Microsoft CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)。
15. 安装指南第 7 节恢复流程拆到公开 `recovery.txt`，Skill 安装参考和构建/公开完整性检查同步引用。官网原有 11 个文件继续校验，并增加这 1 个公开恢复文档，共 12 个文件。

## 依赖与最低版本

新增固定 `@iarna/toml@2.2.5` 用于解析真实配置结构；将已有传递依赖 `cross-spawn@7.0.6` 声明为直接依赖以正确处理 Windows shim。锁文件记录完整依赖。Node 下限保持 18.14.1；SDK 与 hono 固定版本不变。指南安装命令未依赖新增参数，因此安装脚本最低 CLI 仍为 1.3.12。

## 验证及发布记录

产品 PR [#34](https://github.com/bigbrain-work/shiliu-ai/pull/34) 合入 `9b482ec864db89fb2e551824a21cd17ebc07fc3b`。PR CI `38858480305` 和 main CI `38858718275` 三项全部通过：Linux Node 22、Node 18.14.1、Windows；Windows 完整 201 项通过。PowerShell 5.1 安装器分支、真实中文路径进程、分发完整性和构建测试通过。实际 Node 16.20.2 入口退出 3，返回明确的 18.14.1 提示。

2026-10-16 通过 GitHub Release 触发既有 Trusted Publishing，一次发布 npm 1.3.18，工作流 `38859009868` 成功。下载公开 tarball 的 SHA-512/SHA-1 与元数据一致，42 个文件逐个匹配冻结提交；tarball SHA-256 `0538b5879ba8db32ec32f5c089e4f357ee24f2341351d5a7b172718cc0d0394b`。Node 18.14.1/npm 9.9.4 使用新的安装前缀和缓存严格 engines 冷安装，消费 audit=0，9 项 smoke 通过。真实公开入口 `--bogus`、`login --json --session bad`、`--agent mcp`、`--network --json` 以及 `--home - mcp --bogus` 的退出码和错误契约均通过。

官网从同一 main 构建，原有 11 文件与新增 `recovery.txt` 共 12 文件，公开入口及重定向终点逐字节一致。Skill 归档摘要 `sha256:984368d7f3d3e7644e91721ff20c2d0510101020e1c4a66d238d55aed6354ed8`；规范 HTTPS 同源安装可用。已有 11 文件下载备份、SHA256 并发核对、diff 审核、原子替换和 nginx -t 前后校验完成，新恢复文档在本轮新增。Nginx 配置未改，安装文件最低 CLI 保持 1.3.12。

Claude Code 2.1.201 在新的测试项目中以原生 Skill 工具加载官网 Skill，正式 CLI 显式安装并登记目标，原生 MCP 免费余额调用成功且 `charged=false`、`consumed_credits=0`。实际客户端发出的 tools/list 响应含 31 项，证据来自仅透传字节的观察器，不由模型猜测工具数量。另一个未登记 Git 项目的普通任务自动执行一次 refresh，静默跳过，24 个文件摘要不变，无安装尝试、无 --force、无用户提醒。两次余额调用均免费，没有调用收费业务工具。

原生 shiliu_login 创建二维码、原生 shiliu_login_poll 兑换成功并保存凭据，扫码流程通过。

本机通过当次 HTTPS 下载、与 main SHA256 一致的官方安装器，将全局 shiliu 从 1.3.9 升为 1.3.18，并完成 doctor initialize/tools/list 验证。原目录中误生成的 --help 目录确认没有文件或链接后，仅删除空目录树；没有改动后端原目录 123 个文件。

## 已知限制

- 内存保留能保护仍在运行的进程，不能在操作系统凭据库持续不可写时跨进程退出持久化；强制结束进程后可能需要重新登录。短命登录子进程未保存成功时 MCP 明确报告失败，避免把暂存内存说成已保存。
- Linux 需要可访问的 Secret Service 会话。没有 Secret Service 的 SSH/Docker/WSL 不提供明文文件回退。真实 macOS Keychain/Linux Secret Service 故障注入未覆盖；挂起和竞争测试使用隔离 fixture。
- 旧版 repair 锁没有进程启动标识时，无法安全证明活 PID 被复用，继续保守处理。
- remove/add 失败时恢复原配置文件；调用期间应避免另一个程序同时编辑同一配置文件。
- 客户端收到工具目录与模型逐项列出所有工具是两项证据；不靠模型的目录自述替代协议观察，也不调用收费工具验收安装。
