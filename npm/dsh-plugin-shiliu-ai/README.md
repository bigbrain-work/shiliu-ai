# 石榴 AI · DeepSeek Harness

通过 Streamable HTTP 将石榴 AI 的远程 MCP 工具接入 DeepSeek Harness（DSH），支持查询账号余额、解析公开短视频链接、提取文案等能力。工具清单以服务端实时返回为准。余额查询免费，其他工具按各自的石榴 AI 能量点规则计费；安装本插件不等于购买付费服务。

## 兼容环境

- DeepSeek Harness **0.2.2-rc.1**。本版本精确声明已验证的宿主版本，其他版本不承诺兼容。
- Node.js **24.9.0 或更新版本**，以及 DSH 插件管理所需的 pnpm。
- 此 bundle 使用用户自己的 API Key；不会改变其他客户端已有的 OAuth 连接。若已经通过 DSH 自带 MCP 配置连接石榴 AI，无需重复安装本包。

## 安装

在 DSH 插件管理界面添加 npm 包 `@bigbrain-work/dsh-plugin-shiliu-ai@0.1.0`，或运行：

```text
dsh plugin --profile web add @bigbrain-work/dsh-plugin-shiliu-ai@0.1.0
```

这里以 `web` profile 为例；若使用其他 profile，请替换为其实际名称。安装完成后重新启动对应 profile。

## 配置与启动

在 [石榴 AI](https://www.bigbrain.work/shiliuai/) 微信扫码注册或登录，获取自己的 API Key。启动 DSH 的进程需要环境变量 `SHILIU_DSH_MCP_KEY`。未设置时，本插件只提示缺少配置，不注册业务工具。

Windows PowerShell 可通过隐藏输入设置本次启动的凭据，退出后恢复原环境变量：

```powershell
$shiliuKey = Read-Host '石榴 AI API Key' -AsSecureString
$shiliuPriorKey = $env:SHILIU_DSH_MCP_KEY
try {
  $env:SHILIU_DSH_MCP_KEY = [pscredential]::new('shiliu', $shiliuKey).GetNetworkCredential().Password
  dsh web
} finally {
  $env:SHILIU_DSH_MCP_KEY = $shiliuPriorKey
  $shiliuKey.Dispose()
}
```

macOS / Linux 可使用系统的安全凭据管理方式向 DSH 启动进程注入同名变量。桌面客户端必须从能够继承该变量的进程启动；仅在另一个终端设置变量，不会改变已经运行的桌面进程。

不要把真实 Key 放入聊天、公开配置、仓库、截图或命令行参数。不要将含凭据的运行配置导出或公开。

## 首次验证

在 DSH 中配置模型并选择工作区后，发送：

> 用石榴 AI 查询我的能量点余额，不调用其他收费工具。

在调用轨迹中检查 `mcp__shiliu_ai__get_account_balance`。预期返回成功、当前账户余额以及 `charged=false`、`consumed_credits=0`。DSH 自身使用的模型可能另行计费。

本包已验证真实 DSH 工具注册、免费余额调用及卸载。该验证不代表所有模型的自然语言工具选择或所有收费工具均已逐项验收。

## 卸载

```text
dsh plugin --profile web remove @bigbrain-work/dsh-plugin-shiliu-ai
```

移除后重启对应 profile，并清除不再使用的环境变量。卸载本包不会自动注销石榴 AI 账号或撤销 API Key。

## 发现与分发

公开 npm 包可直接按包名安装。DSH 的「发现」使用用户添加的插件索引源，发布 npm 包不等于自动加入平台默认推荐或官方审核列表。参见 [DSH 官方插件索引说明](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)。

## 服务与隐私

- 运营主体：新乡市微尚城科技有限公司。
- 服务入口：https://www.bigbrain.work/shiliuai/
- 隐私政策：https://www.bigbrain.work/shiliuai/privacy.html
- 支持邮箱：support@bigbrain.work
- 本插件代码采用 MIT 许可证；远程服务的账户、额度及收费规则独立适用。
