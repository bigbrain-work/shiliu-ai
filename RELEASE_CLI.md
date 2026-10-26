# 石榴 AI CLI / MCP 连接程序发布流程

适用范围：`@bigbrain-work/mcp-connect` npm 包、官网安装指南及安装脚本。CLI 发布不等于 Java 后端部署；只有修改后端且获得部署授权时，才走 `shiliu-ai-service` 的治理发布流程。

## 目录与入口

| 项目 | 当前入口 |
| --- | --- |
| 会话主项目 | `D:\program\enegry_points_service` |
| CLI、安装文件、Skill 的源码 | `D:\program\shiliu-ai` |
| npm 包目录 | `D:\program\shiliu-ai\npm\mcp-connect` |
| 公共仓库 | `bigbrain-work/shiliu-ai` |
| 官网安装指南 | `https://bigbrain.work/shiliuAI/install.txt` |
| 静态前端源码 | `D:\program\enegry_points_fe` |
| 运维真相源 | `D:\program\all_program_produce` |

2026-10-07 核实的官网静态目录为前端服务器 `47.94.105.123` 的 `/usr/share/nginx/allproduct/dist`。每次发布仍须从运维台账与当次线上 Nginx 配置重新确认，不直接复用历史路径。

## 1. 确认范围和制作独立候选

1. 读取全局及所有涉及目录的 `AGENTS.md`；保留无关改动、未跟踪文件与其他任务。
2. 确认真实 Git 根目录，再查看工作树、远程 main、已发布 npm 版本及 GitHub release。
3. 可以在独立 worktree 和独立分支中基于最新 `origin/main` 整理本次改动；创建或复用前说明原代码目录、实际开发目录和分支。不要直接把原目录的全部未提交改动整体带入或打包，也不要把其他任务的 Skill 改动带入发布。合入前同步最新主分支，处理冲突并验证相关功能；无文本冲突不等于业务兼容。
4. npm 版本不可覆盖，选择尚未发布的新版本。同步 `package.json`、`package-lock.json` 根包版本、版本相关测试及发布说明。仅当指南依赖新增行为时提高安装脚本/指南的最低版本；1.3.13至1.3.17不改变指南正常流程，最低版本仍1.3.12。
5. 如果只更新 CLI 和三个安装文件，保留线上 Skill 包和业务前端资源；不执行整站覆盖。

PowerShell 中每条命令独立执行，并检查退出码。以下命令在 CLI 发布候选目录运行：

```powershell
npm.cmd view @bigbrain-work/mcp-connect version --registry=https://registry.npmjs.org
npm.cmd ci
npm.cmd test
npm.cmd pack --dry-run --json
npm.cmd pack --json
```

打包前检查文件白名单、无凭据、版本一致性；记录 tarball 的 SHA256。使用独立安装前缀安装 tarball，验证版本、登录 dry-run、配置 dry-run、Windows cmd 双向 stdio、匿名 initialize 和工具清单。匿名连接只能提供三个登录/状态工具，不等于远程业务已授权。

在仓库根目录验证安装器与分发文件：

```powershell
powershell.exe -NoProfile -File scripts/test-install-windows.ps1
node --test scripts/public-skill-integrity.test.mjs scripts/p3-installer-build.test.mjs
node scripts/build-public-site-assets.mjs D:\program\.release\RELEASE_ID\public
node scripts/verify-skill-distribution.mjs D:\program\.release\RELEASE_ID\public\.well-known\agent-skills
git diff --check
```

把 `RELEASE_ID` 替换为本次独立发布目录。若需要更新 Skill，还须验证归档及逐文件 SHA256、无 Git 安装和客户端实际发现；不得因为 CLI 发布就自动更新已安装 Skills。

### 每次提交结果的汇报

- 分别核查原代码目录（CLI 为 `D:\program\shiliu-ai`）和本次独立开发目录，写明绝对路径，并列出已跟踪但未提交的文件数、新增未跟踪的文件数和合计。涉及后端时，同样报告 `D:\program\enegry_points_service` 的数量。
- 未跟踪目录展开到文件计数；同一文件暂存与未暂存的变化不重复计数，忽略文件不计入。独立目录零改动不代表原目录零改动，不得只报告“工作目录干净”。
- 单独说明提交编号及本地提交、推送、合入、发布各阶段的实际状态。原目录已有修改可能已通过其他分支提交；未核对前，不把它们一概称为从未提交的功能。
- 合入后检查原目录能否安全同步；保留其他任务的修改，不擅自覆盖、删除或混合提交。不能安全同步时，明确报告遗留数量和原因。

## 2. 发布 npm

优先使用仓库现有 `.github/workflows/publish.yml`：

1. 提交本次候选至 `codex/` 分支，创建 PR，等待必需的 CI 通过并检查所有相关运行结果。
2. 合并 main 后，以对应合并提交创建 `v版本号` GitHub release。标签必须与 npm 包版本完全一致。
3. 观察 Publish npm 工作流的实际结果。GitHub release 成功不等于 npm 发布成功；Trusted Publishing 必须由 npm 包设置正确授权仓库和工作流。
4. 若自动发布报认证/权限错误，不重复盲发、不降低安全策略。使用现有 npm 官方登录与发布流程，或由账号持有人修复 Trusted Publishing。

本机回退方式：

```powershell
npm.cmd login --auth-type=web --registry=https://registry.npmjs.org
npm.cmd publish --access public --registry=https://registry.npmjs.org
```

在经过验证的包目录发布；需要 Passkey、登录或 2FA 时让账号持有人在官方页面完成，不索要密码/验证码，不把 token 放到命令或仓库。不要从本地伪造 provenance；CI 发布按现有工作流使用 provenance。

发布后必须读取公开 npm `dist-tags.latest` 和版本元数据，下载公开 tarball并核对包内容/摘要，再从公网安装验证：

```powershell
npm.cmd view @bigbrain-work/mcp-connect version dist.integrity --registry=https://registry.npmjs.org
npm.cmd install --global @bigbrain-work/mcp-connect@latest --prefer-online
shiliu.cmd --version
```

全局覆盖可能占用原生 DLL；优先用官方 PowerShell 安装器处理明确属于石榴 MCP 的文件占用，避免停止其他 Node/Agent 进程。安装之后必须重连旧 MCP 进程。

## 3. 同步官网安装文件

先等 npm 公开最新版验证通过，再提升官网最低版本，避免客户收到不可安装的版本要求。

1. 三个安装文件唯一源码是 CLI 仓库根目录的 `install.txt`、`install.ps1`、`install.sh`。公开恢复文档为 `recovery.txt`。Skill 变更时一并构建归档、逐文件内容与索引；当前共 13 文件（4 个安装/恢复文件、7 个 Skill 源文件、归档和索引）。从同一候选生成公开文件，不手工维护前端副本。
2. 下载当次线上静态文件并记录 SHA256；上传到新的候选目录，校验候选内容和摘要。
3. 发布前再次核对本轮全部发布文件的线上摘要，发现并发变化则停止并重新准备。创建时间戳备份，再逐文件原子替换；保留其他页面、资源和 Skill 分发文件。
4. 已有路由无需修改 Nginx。确需修改时，遵守 `D:\program\AGENTS.md`：当次下载 live 配置、SHA256 并发核对、diff 审核、远端备份、候选验证、替换后验证、reload 和路由回测。
5. 从公网分别下载大写公开入口和最终小写 www 路径，验证 HTTP、正文、版本与逐文件 SHA256，不能仅看首页 200。
6. 在干净安装前缀执行公开安装器，检查 `CLI installed.` 和实际 CLI 版本。调用 `shiliu doctor --transport stdio --json`，区分本地 stdio、登录状态与远程业务连接。

如果公开 Skill 与候选源码也一致，可以执行 `node scripts/check-public-distribution.mjs`；否则只验证本次发布文件，记录已有差异，不以覆盖 Skill 的方式消除无关差异。

## 4. 业务验收与客户更新

- 无凭据：stdio initialize 成功，三个基础工具可用，业务调用仍要求登录。
- 已登录：通过真实远程 MCP 读取工具列表；免费 `get_account_balance` 可用时通过实际 MCP 通道验证，确认返回零扣费。不要为了验收调用付费工具。
- 日志：致命错误退出 2/3/4，正常关闭 0；未登录、授权过期、网络失败保持连接。安全日志位于用户目录 `.shiliu-ai/logs/mcp-diagnostics.jsonl`。
- 报告版本、源码提交、CI/npm结果、公网文件校验、实际连接状态、备份位置及未验证环节。客户 WorkBuddy 本身的 hook 失败须单独处理，CLI 发布不能证明已修复该客户端。

客户可将下面内容发给 Agent，把最低版本替换成本次公开版本：

```text
请按 https://bigbrain.work/shiliuAI/install.txt 更新已有石榴 AI CLI，不要因为已安装就跳过。更新后检查 shiliu --version，要求至少为本次发布的版本。保留现有登录凭据和其他 MCP 配置，确认 shiliu_mcp 没有固定到旧版本或旧路径。分别执行 shiliu doctor --transport stdio --json、shiliu status、shiliu tools，展示版本、状态和错误分类；告诉我是否需要重连 MCP 或重启客户端。不要索取或输出任何凭据。
```

## 5. 回退

npm 已发布版本不能覆盖。优先修复并发布递增版本；紧急情况下按已验证的旧版本调整 latest 并恢复三个官网安装文件到对应备份。变更 dist-tag 属于正式发布操作，必须在当前授权范围内，回退后再次验证公网安装版本及连接。

## 本次发布记录

2026-10-07：`1.3.10` 候选通过 Windows 全套 99 项 CLI 测试、PowerShell 5.1 安装器检查、13 项归档完整性检查，以及 GitHub 的 validate、cli-node18、windows-validate。PR #19 已合并，源码提交为 `a6984bedd2df5448b290b479a94843a838ce3ef4`，GitHub Release 为 `v1.3.10`。

npm 自动发布运行 `37613484501` 返回 E404 / 发布权限错误；本机登录最初返回 E401。账号持有人完成 npm 官方登录及发布认证后，使用经验证的 tarball 手动发布成功。公开 latest 为 `1.3.10`，公开 tarball 的 integrity 和 SHA256 与测试候选一致。GitHub 自动发布权限仍需以后在 npm 包设置核对，不能把本次手动发布成功当作自动发布已修复。

官网 `install.txt`、`install.ps1`、`install.sh` 已切换，备份位于 `/usr/share/nginx/allproduct/cli-backup-1.3.10-20261007-191314`。大小写公开入口共 6 次下载均为 HTTP 200，正文与候选逐字节一致。其他前端资源、Skill 分发文件和 Nginx 配置未替换。

从公网安装器和 npm latest 做了独立全新安装，输出 `CLI installed. Version: 1.3.10`。公开包匿名 stdio 握手成功，返回 3 个基础工具、0 个业务工具；使用本机现有设备授权后发现 27 个业务工具，并通过实际 MCP 通道调用 `get_account_balance`，返回 `charged=false`、`consumed_credits=0`。客户真实 WorkBuddy 及新扫码仍需客户侧验证；客户更新后需要重连旧 MCP 进程。

发布证据目录：`D:\program\.release\shiliu-cli-1.3.10-20261007-191314`。公开及本地 tarball SHA256 均为 `ae4154ff9ba085996d48d607d588e7da836b335c2dd628a10301374ac2eed7ca`；证据包括 `registry-verification.json`、`public-verification.json`、`bridge-verification.json` 和 `release-state.json`。


### 2026-10-08：CLI 1.3.11 发布完成

本次发布安装预热与真实 stdio 握手校验、独立运行时诊断入口和指定 npx 缓存备份修复。没有发布 Java 后端、Skill 或第四项稳定启动器。独立候选排除了其他任务的直接 Skill 安装改动，保留原工作目录的未发布工作。

PR #20 经 validate、cli-node18、windows-validate 全部通过后合并，源码提交为 `74cd29dbb18ac709435d90aee1dde1a19461d055`，GitHub Release 为 `v1.3.11`。候选 108 项测试、Windows 安装器行为检查和 13 项分发完整性检查通过；测试候选与合并提交的文件树一致。

自动发布运行 `37782570700` 仍返回 E404 / npm 发布权限错误。本机账号持有人完成官方登录和本次发布的独立 Passkey 验证后，使用验证过的 tarball 发布成功。公开 npm latest 为 `1.3.11`；公开包 integrity 与候选一致，SHA256 为 `06c1c4565f94f97c36bd18e04434ac8ebb41adbf63427829d05c6fb42c8c324d`。本次手动成功不代表 Trusted Publishing 配置已修复。

官网三个安装文件已按当次摘要并发核对、备份、逐文件原子替换；备份为 `/usr/share/nginx/allproduct/cli-backup-1.3.11-20261008-205800`。大小写两个入口共六次下载均 HTTP 200，正文与候选逐字节一致。公开 PowerShell 安装器在独立前缀输出 `CLI installed. Version: 1.3.11`，标准 npx initialize + tools/list 通过。没有修改 Nginx 配置或覆盖其他静态资源。

公开包无凭据时 initialize 成功，返回三个登录/状态工具。使用本机现有设备授权后，`shiliu status`、`shiliu tools` 和 stdio 实际握手成功，发现 27 个业务工具；未调用付费工具。客户更新后仍须重连，尚未在客户真实 WorkBuddy 上验收。

真实 npm 缓存修复验收：在本次证据目录的独立 npm 缓存中安装公开 1.3.11，移走 Ajv 的 `dist/2020.js` 模拟缺文件。轻量 `--version` 仍成功，doctor 实际握手返回退出码 3、`child_runtime.reason=DEPENDENCY_INCOMPLETE`。repair dry-run 通过，实际 repair 保留损坏缓存的备份、按原包名重建缓存，并完成新缓存和指定启动方式的两次握手；2019.js/2020.js 均存在，返回 `repaired`、`reload_required=true`，工具共 30 个（3 个基础工具加 27 个业务工具）。没有处理用户原有的 npx 缓存目录。

后续诊断时读取 `stdio_launch.child_runtime.reason` 和实际 node/npm/cache，不用 `--version` 替代依赖完整性检查。客户内置运行时需要指定 `--node-path`、`--npm-cli`、`--npm-cache`，可结合只含无凭据 Shiliu stdio 命令的 `--launch-file`；不能把终端验证通过当作客户端原生加载成功。

Web 发布认证注意：npm 的发布认证流程要求 stdin/stdout 保持 TTY；不要先把 npm publish 的全部输出重定向到文件，否则它会直接返回 EOTP 而不等待网页认证。在 Codex 中使用带 `tty: true` 的官方 npm 命令；可加 `--browser=false`，然后将 npm 提供的官方 URL 在账号持有人的浏览器打开，让 npm 自行轮询。不要读取、传递或写入认证返回的 token/OTP。登录认证与发布认证可能各要求一次 Passkey。发布后用公开 registry 校验作为最终证据，不以浏览器成功提示代替。

发布证据目录：`D:\program\.release\shiliu-cli-1.3.11-20261008-205800`。结果见 `release-state.json`、`registry-verification.json`、`public-verification.json`、`bridge-verification.json`、`repair-verification.json` 和 `public-installer-smoke.log`。


### 2026-10-08：公开 Agent 通用连接排查指南

PR #21 已合并，源码提交为 `28ccd1e60fd3863eb47647f9cc395ae3097fdbdc`。仅更新 `install.txt`，顶部和安装验证步骤引导到第 7 节；按 Agent 能力和实际启动上下文排查，不针对特定客户端。连接未建立或 Skill 未安装时也可从公开地址读取，涵盖错误分类、精确缓存修复、重连及原生工具验证。

13 项分发完整性检查与 validate、cli-node18、windows-validate 均通过（运行 `37786574351`）。当次线上摘要核对后备份并原子替换指南；备份为 `/usr/share/nginx/allproduct/guide-backup-shiliu-agent-troubleshooting-20261008-214500`。两个公开入口均 HTTP 200，与候选逐字节一致，SHA256 为 `68c4afa0a34f6922a8627b8267c1e7cdf5c88fed89b4abdcb3415e431aea0275`；安装脚本、npm 包、Skill 和 Nginx 配置未改动，CLI 仍为 1.3.11。

证据：`D:\program\.release\shiliu-agent-troubleshooting-20261008-214500\public-verification.json`。


### 2026-10-08：安装指南接口用途说明

PR #22 已合并，源码提交为 `0045913bed78986cc1aa3711d98c66c3f40a6e6f`。公开 `install.txt` 顶部新增 Interface overview，集中说明对象、用途、公开只读文本性质、四类适用场景及各自步骤入口，供 Agent 在读取后选择首次接入、CLI 更新、连接失败排查或工具加载验证。

13 项分发完整性检查及三项 CI 全部通过（运行 `37790845268`）。指南经当次 SHA256 并发检查、备份、原子替换后发布；两个公开入口 HTTP 200，正文与候选逐字节一致，SHA256 为 `52723fce83dbd2a122f9fb30cb240db872d460dc8a797d1bf0bedeeae329e71a`。CLI 仍为 1.3.11，两个安装脚本保持原摘要。本次只修改指南。

备份：`/usr/share/nginx/allproduct/guide-backup-shiliu-guide-purpose-20261008-221243`。证据：`D:\program\.release\shiliu-guide-purpose-20261008-221243\public-verification.json`。

### 2026-10-16：P1 与后续版本

1.3.12 的修复、依赖评估、发布结果及旧用户升级通知见 `docs/cli-1.3.12.md` 和发布计划；1.3.13 的参数错误契约见 `docs/cli-1.3.13.md`。1.3.14 的 worker 截止时间见 `docs/cli-1.3.14.md`。各版本独立发布，不能把候选说明当成公开包验收。2026-10-16 已在 Claude Code 2.1.201 通过原生 Skill 发现、31 个 MCP 工具及免费余额调用验收；未登记测试项目的普通任务静默跳过 refresh，未写文件。Codex CLI 0.116.0 因当前配置模型不受账号支持而未完成原生验收。

1.3.15 的认证错误分类、1.3.16 的 repair 锁/UTF-8 以及1.3.17的连接生命周期也已分别发布，公开包和真实客户端证据见各版本说明。最低运行时严格安装、audit及smoke按每个公开版本单独验收，不以另一版本的结果代替。

### 2026-10-16：1.3.18 统一修复发布

PR #29 的余额验收要求及发布协作约定先合入并同步官网。随后 PR #34 集中完成 P2 复核问题及 P3 登录、凭据、配置、下载/文件、安装器和文档修复，中间没有发布 npm 版本，统一发布 1.3.18。201 项最终完整测试及 Node 22/Node 18.14.1/Windows CI 通过；公开包 42 文件匹配冻结 main，严格最低运行时冷安装、audit=0、smoke 及 Claude Code 原生免费余额、31 项客户端目录、未登记项目静默跳过验收结果见 [1.3.18 发布记录](docs/cli-1.3.18.md)。扫码状态以该记录的实际结果为准，不把展示二维码当成登录成功。

官网 12 文件与 main 一致，新增公开 recovery.txt；安装脚本最低 CLI 保持 1.3.12。本机全局 CLI 已通过官方安装器升级到 1.3.18。后端原目录 123 文件未纳入本批修复。

### 2026-10-26：CLI 1.3.19 依赖修复与旧 Skill 登记引导

PR #37 已合入，发布源码 `eaba59315e1b2398cdbf28e6d15bbd17476a1706`。Zod 4.6.7 和三个间接依赖修复、旧 Skill 的 doctor 只读诊断与显式安装引导合并为一个版本。Node 22 的 209 项测试、Node 18.14.1 的 35 个测试文件及三项 CI 通过；Claude Code 2.1.201 原生握手、35 项工具发现、免费余额调用和配置保留验收通过，业务扣费 0 点。

GitHub Release v1.3.19 触发 Trusted Publishing，运行 `40317351578` 成功。等待 npm 处理完成后，公开 latest 为 1.3.19；43 个文件匹配冻结 main，公开 tarball 与原生验收候选完全一致，SHA256 为 `23115ce63fb6660100a7d6cecedcaed7693059e608c7663f910c6ef20a0ed4e1`。Node 18.14.1 全新缓存及独立前缀严格 engines 安装、审计 0 和 9 项 smoke 通过。

官网只替换 install.txt，安装脚本、Skill 和页面保持原摘要；即时下载、并发复核、diff 审阅、备份及原子替换后，两个入口共 26 个下载全部匹配。备份为 `/usr/share/nginx/allproduct/guide-backup-shiliu-cli-1.3.19-20261026-194240`。官方公开安装器在独立前缀安装 1.3.19 并通过实际 stdio 握手；本机全局命令也已更新。旧客户端须重连，旧 Skill 仍须明确选择目标后登记，自动刷新不接管历史副本。

CLI 原目录安全同步并重装锁定依赖，重装前完整备份校验旧 node_modules 的 4115 个文件。未部署 Java 后端、未修改 Nginx、未调用付费业务工具。完整记录见 [CLI 1.3.19 发布记录](docs/cli-1.3.19.md)，证据目录为 `D:\program\.release\shiliu-cli-1.3.19-20261026-194240`。
