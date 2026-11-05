# WorkBuddy / DSH 本地配置适配

状态：2026-11-05 已获用户授权提交与发布，结果以本次发布后的实际核验为准。保留客户端原有错误描述，本次仅同步必要的安装调用方式。
开始本轮前，原目录已有另一对话留下的个人地址交接脚本、指南等 13 个未提交文件；本轮在其基础上补配置适配。

## 安装器调用

不需要 Node/npm。先核实当前客户端实际使用的配置文件及修改权限，再把同目录的
`connect-mcp.ps1`、`configure-mcp-client.ps1`、`connect-personal.ps1` 下载到本机。
不要把凭据或完整专属地址传入命令行、对话或报告。

```powershell
# 首次配置 / 字段修正，不触发网页凭据交接。
.\connect-mcp.ps1 -Client workbuddy -ConfigPath 'C:\已核实目录\mcp.json'
.\connect-mcp.ps1 -Client dsh -ConfigPath 'C:\已核实目录\cordis.patch.yml'

# 仅确认当前客户端 OAuth 不可用、授权实际失败，或用户要求恢复失效专属地址时使用。
# 用户仍须在官方网页上明确同意；不要求用户复制 Key。
.\connect-mcp.ps1 -Client dsh -ConfigPath 'C:\已核实目录\cordis.patch.yml' -UsePersonalUrl -SkipEditingCredential
```

WorkBuddy 使用官方文档中的 `mcpServers.shiliu_mcp.type=streamableHttp`。
保留其他服务器和配置字节，仅替换石榴对象或插入缺失属性；目标 JSON 文件不存在且父目录已存在时可创建。
已有 stdio、非官方 URL、自定义认证头或显式禁用的连接不转换。

DSH 使用顶层 Cordis 插件列表，插件名 `@deepseek-ai/dsh-mcp-client`，
`config.serverName=shiliu_mcp`、`config.transport=streamable-http`。
仅处理已核实的现有 profile 文件；保留其他插件，重复条目、未知 YAML 布局、自定义认证头等直接保留并报错。
不猜默认 profile，不写另一份未被客户端加载的配置。

所有已有文件在替换前核对 SHA256，原子替换并保留备份；保留 UTF-8 BOM。
配置适配阶段可以先保存官方未认证地址；之后拒绝网页同意时，不写入个人地址，已修正的连接字段保留。
成功报告仍为 `native_mcp_verified=false`；须由目标客户端发现原生工具并免费查询余额后完成验收。

## Skill 目录

```powershell
# DSH 用户目录默认 ~/.dsh/skills，尊重用户范围 DSH_HOME；项目范围为项目/.dsh/skills。
.\install-skill.ps1 -Client dsh -Scope user

# WorkBuddy 不借用 Cursor 的 .agents 目标；按当前客户端实际支持的位置显式指定。
.\install-skill.ps1 -Client workbuddy -TargetDir 'C:\已核实的技能父目录'
```

两者均只安装 `shiliu-ai-mcp`，已有副本保留，不更新其他 Skill。
文件安装、客户端识别、当前会话加载分别验收，不以目录出现声称生效。

## 验证

`scripts/test-configure-mcp-client.ps1` 覆盖新配置、WorkBuddy 错字段、其他连接保留、DSH 插件追加、
重复条目与未知布局、已有凭据保护，以及两客户端配置到网页交接的完整模拟。
与个人地址交接、Skill 安装、原客户端流程一起在 PowerShell 5.1 / 7 验证。
测试网络、浏览器、凭据均为模拟，未修改本机实际客户端配置或访问真实账户。

分发构建包含新增适配脚本；没有生成到前端 public，也没有发布官网。

## 依据

- [WorkBuddy MCP 配置](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)
- [DSH MCP 客户端配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)
- [DSH Skill 来源目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)
