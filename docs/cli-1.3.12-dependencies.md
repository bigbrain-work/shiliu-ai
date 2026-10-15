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

## 四项既有告警

本次重新执行 npm audit，结果仍为 1 critical、1 high、2 moderate。下面四个版本都与本次分支基线 origin/main 相同；本批没有升级或消除这些告警。

| 包 | 本地版本 | npm audit 等级 | 已知核对范围 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.29.0 | high | 告警涉及 OAuth 客户端把凭据发送给服务端指定的授权服务器 |
| proxy-addr | 2.0.7 | critical | 告警涉及 IPv4-mapped IPv6 信任子网的地址伪装 |
| fast-uri | 3.1.7 | moderate | 告警涉及百分号编码字符的主机名大小写规范化 |
| ip-address | 10.7.0 | moderate | 告警涉及跨地址族子网判断及长输入解析诊断的资源消耗 |

这里只记录 audit 报告的受影响行为，没有完成当前 CLI 的全部调用路径可达性证明，也不将“历史已有”当作安全放行理由。合入判断与发布判断分开：这次 P1 修复可单独复核；正式发布前需对上述告警给出适用性判断或升级修复方案，并按实际变更验证兼容性。不要未经核对直接运行 npm audit fix 或混入无关 SDK 升级。

复核证据保存在本次本地交付目录的 `proper-lockfile-registry.json`、`lock-dependencies.json`、`npm-audit-followup.json` 和 `dependency-baseline.json`；正式发布时将最终依赖树、audit 和包摘要与发布证据一并保存。
