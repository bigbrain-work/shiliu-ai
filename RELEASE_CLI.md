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
3. 在独立 worktree 中基于最新 `origin/main` 整理本次改动。不要直接把脏工作目录整体打包，也不要把其他任务的 Skill 改动带入发布。
4. npm 版本不可覆盖，选择尚未发布的新版本。同步 `package.json`、`package-lock.json` 根包版本、两种安装脚本的最低版本、安装指南、版本相关测试及发布说明。
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
node --test scripts/public-skill-integrity.test.mjs
node scripts/build-public-site-assets.mjs D:\program\.release\RELEASE_ID\public
node scripts/verify-skill-distribution.mjs D:\program\.release\RELEASE_ID\public\.well-known\agent-skills
git diff --check
```

把 `RELEASE_ID` 替换为本次独立发布目录。若需要更新 Skill，还须验证归档及逐文件 SHA256、无 Git 安装和客户端实际发现；不得因为 CLI 发布就自动更新已安装 Skills。

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

1. 三个安装文件唯一源码是 CLI 仓库根目录的 `install.txt`、`install.ps1`、`install.sh`。从同一候选生成公开文件，不手工维护前端副本。
2. 下载当次线上静态文件并记录 SHA256；上传到新的候选目录，校验候选内容和摘要。
3. 发布前再次核对线上三个文件摘要，发现并发变化则停止并重新准备。创建时间戳备份，再逐文件原子替换；保留其他页面、资源和 Skill 分发文件。
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

2026-10-07：准备发布 `1.3.10`，内容为登录前 stdio 握手、登录/状态基础工具、错误分类/退出码和安全诊断日志。实际完成状态以本节后续记录及公开 npm 校验为准，不能把“候选准备好”写成“已发布”。
