# CLI 间接依赖修复与 Zod 4 升级评估

核查日期：2026-10-26。本文记录提交 `be2e177` 的第一阶段评估，基线为 main `a883193`，当时 CLI 版本为 `1.3.18`。后续 Zod 正式升级及旧安装引导已继续在同一开发分支实现，当前候选状态见 [CLI 1.3.19](cli-1.3.19.md)；下文“本分支”指第一阶段的状态。

## 本分支修改

只通过普通、满足现有 semver 范围的更新调整 `npm/mcp-connect/package-lock.json`：

| 依赖 | 更新前 | 更新后 | 来源 |
| --- | --- | --- | --- |
| body-parser | 2.3.0 | 2.4.0 | MCP SDK → Express |
| fast-uri | 3.1.8 | 3.1.9 | Ajv |
| hono | 4.13.7 | 4.13.14 | MCP SDK / @hono/node-server |
| qs | 6.16.0 | 6.16.1 | body-parser 2.4.0 要求的补丁升级 |

没有新增 overrides，没有修改直接依赖、SDK 版本、CLI 版本或业务代码。
复现命令（在 `npm/mcp-connect` 中）：

```powershell
npm.cmd update body-parser fast-uri hono --package-lock-only --ignore-scripts --no-fund
npm.cmd ci --no-audit --no-fund
npm.cmd test
npm.cmd audit --omit=dev
```

锁定依赖的生产审计从 2 高危、2 中危降至仅 Zod 的 1 项高危。`npm audit` 仍会返回非零退出码，不能宣称漏洞已全部修复或全部 CI 已通过。
包外独立前缀的冷安装同样取得上述三个修复版本；冷安装审计可能把依赖 Zod 的 CLI 包也计为受影响项，但剩余根因仍只有 Zod。

这些是 JavaScript CLI 的依赖修复，与 Java 后端的生产部署无关。本分支不发布 npm、不修改官网、不接管未登记的 Skill 安装。

## 本分支验证

- Node 22.16.0：完整 201 项测试通过。
- Node 18.14.1：完整 34 个测试文件通过；旧版测试运行器按文件汇总，不能将该计数误读为只运行 34 个测试用例。
- 分发与安装器构建测试：14 通过、1 按平台条件跳过；Windows 安装器行为检查通过。
- 打包成功，包文件白名单仍为原有的 42 个文件。
- 使用 Node 18.14.1 与 npm 9.3.1 在独立前缀严格检查 engines 后安装 tarball 成功；版本、登录 dry-run、Skill 安装 dry-run 和未登记目标的强制刷新检查通过，未创建测试用户目录。
- stdio 初始化、匿名登录门禁、HTTP 远端代理、登录状态切换、工具调用、Skill 安装与刷新由已有完整测试覆盖。本轮未进行真实账号扫码、付费调用或客户 Agent 的原生验收。

注意：npm 分发包不包含 package-lock.json。此次锁文件保证源码与 CI 的可重复安装，不能据此宣称用户现有的 node_modules 已更新。独立 tarball 冷安装已确认，当前注册表解析得到修复版本；正式发布仍应针对选定版本和公开 tarball 重新验收。

## Zod 4 的改动范围

### 静态核查

1. CLI 的 `src`、`test`、`test-support` 没有直接使用 Zod 建立 schema。源码仅在运行时预检的模块白名单中引用模块名 `zod`，不需要因为主版本变化修改该列表。
2. 当前 MCP SDK `1.32.1` 的依赖与 peerDependencies 均声明兼容 `^3.25 || ^4.0`，没有发现必须同时升级 SDK 的理由。
3. SDK 的 `dist/esm/types.js` 已经从 `zod/v4` 导入协议 schema；`server/zod-compat.js` 同时处理 `zod/v3` 和 `zod/v4-mini`；JSON Schema 转换也有对应分支。
4. 因此从 `zod@3.25.76` 升级到 `4.6.7`，预计正式源码修改集中在 package.json 与 package-lock.json。不能把“没有直接业务 API 迁移”当作无需回归：SDK 的协议解析、错误格式、schema 转换仍受所安装的 Zod 实现影响。

### 独立副本试验

在仓库外独立副本安装 `zod@4.6.7`，未修改本分支的 Zod 版本或 SDK 代码：

- SDK 与 zod-to-json-schema 复用同一个 Zod 4.6.7，没有残留的 Zod 3 依赖副本。
- 该副本生产依赖审计为 0 漏洞。
- Node 22 下完整 201 项测试通过。
- Node 18.14.1 下完整 34 个测试文件也全部通过。

这些结果支持将 Zod 4 正式升级与“旧安装的显式登记引导”放在下一次统一 CLI 发布中，不必为了本次锁文件更新单独发布一个版本。正式升级尚未合入本分支；真实客户端、公开安装包和扫码登录仍应作为下一阶段的验收项。

## 旧 Skill 安装更新的边界

继续保留自动刷新只更新已登记、仍有效目标的规则。下一阶段可以在显式 `skill install`、`doctor` 场景提供检查和登记提示，但自动刷新不能扫描后静默接管旧目录。明确用户选择的目标与实际路径，才登记并更新；保留其他 Agent 和项目的安装。

## 上游资料

- [body-parser 漏洞与修复版本](https://github.com/advisories/GHSA-27r3-jxmh-p828)
- [fast-uri 漏洞与修复版本](https://github.com/advisories/GHSA-w74x-v6f9-j3xg)
- [Hono 漏洞与修复版本](https://github.com/advisories/GHSA-5r4p-p66f-jhc7)
- [Zod 4 官方迁移说明](https://zod.dev/v4/changelog)
- [Zod 资源消耗漏洞](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
