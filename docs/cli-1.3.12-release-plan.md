# 1.3.12 发布命令与验收清单

本文件保留分阶段的发布命令模板，不代表所有步骤都待执行。2026-10-16，CLI/npm 1.3.12 和配套后端修复已发布并验收；官网11个文件已逐字节验收，Claude Code2.1.201原生客户端及未登记项目验收已完成，升级通知已发布到官网安装页和版本说明。全部步骤按本轮整体授权完成，无需重新确认；下文是以后使用时须重新核对版本和范围的命令模板。版本实际提交、结果和未验收项统一记录在 [cli-1.3.12.md](cli-1.3.12.md)。不要复制整份文件重复发布已经存在的版本。

## 0. 发布前冻结

合入前需 CI 全通过、四项依赖告警结论复核通过；客户端实际 Skill 发现、真实 Keychain/Secret Service 刷新未验收时必须明确记录。按用户授权合入对应 main，重新取实际合并提交，不能用本地分支提交冒充 main。

在独立 CLI 发布目录执行以下 PowerShell；先核实真实 Git 根，不操作原目录无关修改：

```powershell
git fetch origin
git rev-parse origin/main
npm.cmd ci --prefix npm/mcp-connect
npm.cmd test --prefix npm/mcp-connect
npm.cmd audit --prefix npm/mcp-connect --json
node --test scripts/public-skill-integrity.test.mjs
powershell.exe -NoProfile -File scripts/test-install-windows.ps1
npm.cmd pack --prefix npm/mcp-connect --dry-run --json
git diff --check
```

逐条检查退出码，冻结 main 完整 SHA、CI 运行及依赖树。首次发布前必须核对目标版本尚未存在；1.3.12 现已发布，不应重复执行 publish。后续版本同样先重查，若已被占用则停止并重新确定版本。

## 1. npm 发布（单独授权）

默认使用现有 release 事件触发的 Publish npm 工作流，不同时手工重复 publish。先在明确的 main 发布候选上设置 `$cliMainCommit` 为已验证完整 SHA：

```powershell
npm.cmd view @bigbrain-work/mcp-connect dist-tags versions --json --registry=https://registry.npmjs.org
gh release create v1.3.12 --repo bigbrain-work/shiliu-ai --target $cliMainCommit --title 'CLI 1.3.12' --notes-file docs/cli-1.3.12.md
gh run list --repo bigbrain-work/shiliu-ai --workflow publish.yml --limit 5
gh run view $publishRunId --repo bigbrain-work/shiliu-ai --json status,conclusion,headSha,url
```

`$publishRunId` 从对应 tag 的运行中确认。只有 success 才继续；失败先查明原因，不盲发、不降安全策略。需要账户登录/2FA 时由账户持有人完成。手动 npm publish 仅作明确批准的回退路径，不能与仍在运行的工作流并行。

在全新的验收目录验证公开包，以下变量均由当次执行者设置为本次专用绝对路径；先断言目标不存在，再 mkdir，不能复用本机全局 CLI：

```powershell
npm.cmd view @bigbrain-work/mcp-connect@1.3.12 version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org
npm.cmd pack @bigbrain-work/mcp-connect@1.3.12 --pack-destination $publicPackageDirectory --json --registry=https://registry.npmjs.org
npm.cmd install --prefix $coldInstallPrefix --no-fund @bigbrain-work/mcp-connect@1.3.12 --registry=https://registry.npmjs.org
npm.cmd ls --prefix $coldInstallPrefix @modelcontextprotocol/sdk fast-uri ip-address proxy-addr --json
npm.cmd audit --prefix $coldInstallPrefix --json
$coldCli = Join-Path $coldInstallPrefix 'node_modules/.bin/shiliu.cmd'
& $coldCli --version
& $coldCli skill install --agent claude-code --scope user --dry-run --json --home $isolatedUserDirectory
```

验收：确为 1.3.12；公开 tarball 完整性匹配 npm 元数据；包文件与冻结提交一致；解析 SDK 1.32.1、@hono/node-server 1.19.17 及修复后的传递依赖，audit 无这四项告警；dry-run 指向隔离用户 `.claude/skills/shiliu-ai-mcp`，不创建该路径。另用 Node 18.14.1 + npm 9.9.4 对公开包执行 --engine-strict 全新安装，不用开发锁文件代替该验收。

再从一个从未登记的新 Git 项目执行以下命令，命令工作目录必须切到 `$unregisteredProject`。事前/事后保存包含隐藏文件的文件清单及摘要：

```powershell
git init --quiet $unregisteredProject
Push-Location -LiteralPath $unregisteredProject
try {
  & $coldCli skill refresh --force --json --home $isolatedUserDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Unregistered refresh failed' }
} finally { Pop-Location }
```

必须返回 skipped/target_not_registered、退出 0，清单/摘要不变；不新增 `.agents`、`.hermes`、`skills-lock.json` 或隔离 home 状态。公开安装失败时不继续上线新最低版本指南。

## 2. 官网安装文件及完整 Skill 分发（单独授权）

从冻结的同一个 main 提交生成产物，发布目录是新的绝对路径：

```powershell
node scripts/build-public-site-assets.mjs $publicCandidate
node scripts/verify-skill-distribution.mjs (Join-Path $publicCandidate '.well-known/agent-skills')
```

必须包含三个安装文件、Skill tar.gz、全部逐文件内容、SHA-256 及 index.json。先逐项登记清单、摘要和对应提交；不要复制业务前端构建或覆盖整站。执行前从 all_program_produce 台账和即时 live 路由确认 `$publishHost`、真实静态根及公开 URL，不能照抄历史主机/目录；现有路由足够时不改 Nginx。

命令模板中的 `$remoteStage` 为新的暂存目录；上传只到暂存区：

```powershell
ssh "root@${publishHost}" "mkdir -p -- '$remoteStage'"
scp -r $publicCandidate "root@${publishHost}:${remoteStage}/public"
```

以下是远端 Linux Bash 文件发布段，必须保存为脚本、评审后 scp，再通过 ssh 执行；不要把它拼进本地 PowerShell。`live`、`stage`、`backup` 是当次核实的绝对目录；`ordered-files.txt` 是从候选清单生成并审核过的相对路径白名单，index.json 最后一项。第一阶段先下载/保存全部 live 文件及 SHA-256，缺失项记到 expected-absent.txt；在发布前再次核对，任一并发变化即停止。

```bash
set -euo pipefail
test "$(realpath -e -- "$live")" != /
test "$(realpath -e -- "$stage")" != /
sha256sum -c -- "$stage/expected-live.sha256"
while IFS= read -r relative; do
  case "$relative" in /*|*..*) exit 2;; esac
  test ! -e "$live/$relative"
done < "$stage/expected-absent.txt"
test ! -e "$backup"
mkdir -p -- "$backup"
while IFS= read -r relative; do
  case "$relative" in install.txt|install.sh|install.ps1|.well-known/agent-skills/*) ;; *) exit 2;; esac
  case "$relative" in *..*) exit 2;; esac
  test -f "$stage/public/$relative"
  if test -e "$live/$relative"; then
    mkdir -p -- "$backup/$(dirname -- "$relative")"
    cp -p -- "$live/$relative" "$backup/$relative"
  fi
  mkdir -p -- "$live/$(dirname -- "$relative")"
  next="$live/$relative.shiliu-1.3.12-$$.next"
  test ! -e "$next"
  cp -p -- "$stage/public/$relative" "$next"
  mv -- "$next" "$live/$relative"
done < "$stage/ordered-files.txt"
```

这段不是独立的通用发布器：输入清单、源摘要、expected-live 中的绝对目标路径、所有新增缺失项、目录/符号链接及权限都必须在当次评审中核实。传输目录实际结构也须核实后再执行。先创建备份，分文件同目录原子替换，索引最后更新；任何中途失败停止并按备份清单恢复，不能清空整目录。若需 Nginx 变更，另行遵循 live 下载、SHA 并发检查、diff、备份、nginx -t、reload、路由回测。

公网复核使用同一冻结源码生成期望字节：

```powershell
node scripts/check-public-distribution.mjs
```

该脚本核对三个安装文件、归档、逐文件内容、索引摘要及 npm 版本。再确认公开入口的重定向终点，从终点重复字节核对，记录状态码、最终 URL 和各文件 SHA-256。使用新验收前缀跑公开安装器和 stdio doctor；不能以首页 200 或 CLI installed 单独判成功。实际客户端发现 Skill 仍需在客户端重载后确认，不把落盘当发现。

## 3. 后端发布（单独授权，可先于 CLI）

Codeup 后端 MR 合入 main 也需授权。它不依赖 CLI 1.3.12，部署后旧 CLI 立即受益；因此本节允许独立提前执行。读取实际 main 完整 SHA，并核对 main 检查、ops-admin 事件对应同一提交。当前 Jenkinsfile 已使用持久 Maven 缓存、Java 21 和固定共享工具版本；不改构建/基础设施。

本地针对性回归命令：

```powershell
mvn.cmd -q -Dtest=DouyinClientTest,McpControllerTest test
```

按 ops-release-merge-prod 现有入口准备/执行，先从即时台账确认北京二管理节点，不把下面历史地址当永远有效；`$backendMainCommit` 必须是已通过检查的 main 完整 SHA：

```powershell
$mergeScript = 'C:\Users\Administrator\.codex\skills\ops-release-merge-prod\scripts\ops_release_merge_prod.py'
scp $mergeScript root@8.147.105.37:/tmp/ops_release_merge_prod.py
ssh root@8.147.105.37 "python3 /tmp/ops_release_merge_prod.py --service-id shiliu-ai-service --commit $backendMainCommit --dry-run"
```

确认事件、治理和 MERGE_PROD 准备结果后，只有明确发布授权才执行：

```powershell
ssh root@8.147.105.37 "python3 /tmp/ops_release_merge_prod.py --service-id shiliu-ai-service --commit $backendMainCommit --note mcp-play-count-business-errors"
```

记录 merge_execute、Codeup prod SHA、Jenkins prod 结果、两个实例镜像/源码提交和健康。禁止直接 push prod、手工重启绕过治理或把健康 UP 当业务验收。

业务验收：先运行 `shiliu tools --json` 获取当时 schema。对一条已核实会触发下游业务失败的样本，参数存专用 JSON 文件后，仅执行一次：

```powershell
shiliu call get_douyin_video_play_count --args-file $knownFailureArguments --out $failureEvidence
```

检查完整 MCP 结果有 isError=true、原错误提示，无 JSON-RPC error/-32603；再在同一个已连接的旧代理 MCP 会话中核对 tools/list 和连接状态。单独 shiliu tools 建立的新连接不能证明旧连接没有被清空。结合日志确认失败发生在扣点前，不重复调用。**此故障模板仍需单独准备已知下游失败样本**，后续执行模板前须核对是否收费；不能用缺参/随意非法链接代替非零业务码，也不能凭模拟测试声称生产验收完成。没有合适样本时明确保留此项未验，而不是制造生产下游故障。

## 4. 旧用户通知（本轮已发布；后续按实际授权渠道）

“请按官网安装指南升级全局 Shiliu CLI，确认 shiliu --version 至少为 1.3.12，再重连 MCP。新 npx 代理不会自动升级全局 shiliu。旧版可能在未登记项目里留下 Skill 副本；升级不会自动删除。需要检查时运行 skill refresh --json，在明确确认后选择显式登记或手动移除具体副本，保留其他 Skill 和共享锁文件。”

本轮在npm、官网及对应验收完成后，已通过官网安装页和GitHub版本说明发出；未发送邮件或聊天消息。后续只在相应验收完成并确认渠道与受众后通知。每个发布阶段将准确版本、提交、结果、备份和未验证项记入版本说明，失败时停在当前阶段。
