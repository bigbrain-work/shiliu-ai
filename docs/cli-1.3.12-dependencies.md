# CLI 1.3.12 候选依赖评估

核对日期：2026-10-15。范围是本地候选，不代表已经发布或完成全部安全验收。版本变更和实际发布结果统一回填 [cli-1.3.12.md](cli-1.3.12.md)；本文件保留依赖评估细节，不另记一套发布结果。

## 新增跨进程锁依赖

`proper-lockfile` 在 package.json 中精确固定为 `4.1.2`。[npm 官方元数据](https://registry.npmjs.org/proper-lockfile)显示该版本发布于 2021-01-25；发布时间较早是维护风险信号，本身不能证明不安全。本次查询的 npm audit 没有报告下面四个包的告警，不等于已证明不存在漏洞。

| 包 | 本地锁文件解析版本 | 许可 | 运行作用 |
| --- | --- | --- | --- |
| proper-lockfile | 4.1.2 | MIT | 原子 mkdir 占锁、mtime 心跳、过期锁恢复及释放 |
| graceful-fs | 4.2.11 | ISC | 文件系统兼容及资源不足时的文件操作重试 |
| retry | 0.12.0 | MIT | 等待锁时的重试；本项目设为最多 300 次、100ms 固定间隔 |
| signal-exit | 3.0.7 | ISC | 注册退出/信号处理，尽力释放本进程持有的锁 |

核对这四个实际安装版本的 package.json，均没有 preinstall/install/postinstall 安装钩子；发布、测试用 scripts 不会因为作为普通依赖安装而自动执行。锁库的运行逻辑通过 Node 文件系统和定时器实现，不需要远程服务或执行 shell。异常退出后的兜底仍依赖 mtime 过期恢复，不能声称所有强制退出都会立即清锁。

采用现有锁库是为了复用原子占锁、心跳及恢复逻辑，减少自行实现跨进程锁的竞争窗口。测试覆盖两个进程竞争、旧进程不加锁兼容、异常释放、过期锁恢复、持锁失败分类以及释放后的恢复。默认 stale 为 120 秒、heartbeat 为 5 秒；30 秒等待耗尽会暂时报 CREDENTIAL_UNAVAILABLE，不要求重新扫码。keyring 子进程本身没有超时的旧问题仍然存在。

默认锁根为 `os.homedir()`，与项目和 npm 缓存无关。CLI `--home` 只影响其相应 CLI 状态/路径，不作为锁函数的 home 选项传入；不同 `--home` 不会自行拆成两把凭据锁。测试通过注入锁 home 或隔离子进程的 OS home 验证，不写入真实用户目录。

包分发需要区分：我们自己的 npm tarball 不内嵌这四个 node_modules，npm 会根据 dependencies 安装。proper-lockfile 的三个传递依赖声明为范围，消费者安装不会采用本仓库 package-lock.json。因此不能把本地解析版本当成未来每次消费安装都严格固定的版本；公开 npm 验收时要重新核对实际依赖树和 audit。

## 四项告警的发布前结论

最初候选存在 1 critical、1 high、2 moderate；2026-10-15 已逐项核对引入链及运行路径，并在 1.3.12 候选内升级。当前 package-lock 的 npm audit 为 **0 告警**。不以“历史已有”或“未观察到调用”为理由保留易修复的旧版本。

| 包 | 引入链 | 旧版本 → 候选版本 | 修复下限 / 来源 | 当前 stdio 路径结论 |
| --- | --- | --- | --- | --- |
| @modelcontextprotocol/sdk | CLI 直接依赖 | 1.29.0 → 1.32.1 | >=1.31.0，[SDK 公告](https://github.com/advisories/GHSA-6qxp-vccf-f47h) | 桥接也有上游 HTTP 客户端，不能仅因本地 stdio 就判无影响；核对 remote-client.js 只设置 Bearer header，没有 authProvider、withOAuth 或直接 auth/fetchToken 调用，自有 DeviceAuthClient 独立向配置的授权端点刷新，不使用 SDK OAuth 发行者发现。告警所述跨发行者 OAuth 分支未启用，仍升级以消除依赖风险。 |
| fast-uri | CLI/SDK → ajv@8.20.0 → fast-uri | 3.1.7 → 3.1.8 | 3.x >=3.1.8，[规范化公告](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) | **会执行**：AJV 编译/解析工具 JSON Schema 时调用 parse、serialize、resolve。未发现 CLI 用其结果做网络主机白名单；端点检查使用 URL，但不能把该库认作未加载，因此采用兼容补丁。 |
| proxy-addr | SDK → express@5.2.1 → proxy-addr | 2.0.7 → 2.0.8 | >=2.0.8，[代理信任公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) | 属于 Express HTTP 服务端 req.ip/信任代理路径。产品启动 StdioServerTransport，不创建 Express 应用，也没有 trust proxy 配置；已测 stdio 初始化、工具清单和调用未加载该包。仍更新锁文件到修复版。 |
| ip-address | SDK → express-rate-limit@8.7.0 → ip-address | 10.7.0 → 10.7.4 | 两项公告均 >=10.7.1，[地址族判断](https://github.com/advisories/GHSA-j6r3-76f7-8jcv)、[长输入诊断](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) | 产品没有创建 SDK 的 Express 限流路由，也不解析入站 HTTP 客户端 IP；已测 stdio 路径未加载该包。仍更新兼容的 10.x 修复版本。 |

核对方法包括本地源码导入/调用检查、npm explain 和运行观测。隔离的真实 stdio 子进程经本地模拟远端完成 initialize、tools/list、echo 调用，并在加载/调用处记录包名和函数次数；fast-uri 被调用，Express、express-rate-limit、proxy-addr、ip-address 未加载。另覆盖 CLI 参数校验测试。该观测不等于证明未来新增的所有路径都不可达；使用的是本地合成凭据，没有连接真实 OAuth/生产服务。SDK 的 OAuth 凭据 issuer 迁移不适用于当前自有 device token 存储，未来引入 SDK OAuth 时必须重新评估。

升级保留 SDK 1.x，不改变产品参数、认证存储和代理协议。SDK 1.32.1 声明 Node >=18；完整 131 项测试在 Node 22.16.0 通过，最低 Node 18.14.1 全部 26 个测试文件通过。三个传递包只做兼容范围内的锁文件更新，没有运行自动 audit fix，也没有升到 fast-uri 4.x。原有 proper-lockfile 四包仍无本次 audit 告警。

另有冷安装与开发锁文件的差异：SDK 允许 `@hono/node-server` 的 1.x 或 2.x；在 Node 22 全新消费安装时实际选中了要求 Node >=20 的 2.1.5，而 npm ci 保留 1.x，这会让不同安装运行时得到不同的 engines 支持范围。为维持完整依赖树的 Node 18.14.1 契约，CLI 直接精确固定兼容的 `@hono/node-server@1.19.17`；它满足 SDK 的范围，并在全新消费安装中被 SDK 复用，没有加载新的 HTTP 服务端路径。

已复现未加约束的候选在 Node 18.14.1 + npm 9.9.4 + --engine-strict 冷安装时因 Hono 2.1.5 报 EBADENGINE。同环境从约束后的新 tarball 全新安装成功，实际树只有 Hono node-server 1.19.17，audit 为 0、9 个入口检查通过、未登记项目摘要不变。CI 的 Node 18 任务也改为精确 18.14.1，并增加打包后严格 engines 冷安装、audit 和无写入 smoke，避免仅靠 npm ci 掩盖消费解析差异。此约束不表示没有它时所有 Node 18 用户必然安装失败。

发布判断：四项已知告警在当前候选依赖树中已消除，代码及证据交复核后再决定发布。实际重新打包、全新前缀安装得到同样的四个修复版本，消费者依赖树 audit 也为 0；9 个入口检查通过，未登记 Git 项目的文件摘要不变，未创建隔离 home。公开包安装仍需重新审计，不能用本地结果代替发布后的消费者解析结果。发布工作流已在 npm publish 前加入 audit 门禁，moderate 及以上告警会阻止发布；没有把零告警等同于不存在未知漏洞。

复核证据包括交付目录中的 dependency-chains-before.json、dependency-explain-after.json、dependency-chains-after.json、dependency-audit-after.json、dependency-runtime-after/ 及对应测试输出；原始 audit 和新增锁库元数据也保留。正式发布时将最终依赖树、audit 和包摘要与发布证据一并保存。
