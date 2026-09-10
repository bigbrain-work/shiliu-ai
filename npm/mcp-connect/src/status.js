import { readFile } from "node:fs/promises";
import path from "node:path";

import { AUTH_URL, MCP_URL, PACKAGE_NAME, SERVER_NAME } from "./constants.js";
import { resolveAuthorization } from "./authorization.js";
import { readToolCatalog } from "./remote-client.js";

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function hasServerConfig(filePath) {
  const content = await readText(filePath);
  return (
    content.includes(SERVER_NAME) &&
    (content.includes(MCP_URL) || content.includes(PACKAGE_NAME))
  );
}

export async function inspectLocalConfiguration(home) {
  return {
    codex: await hasServerConfig(path.join(home, ".codex", "config.toml")),
    claude: await hasServerConfig(path.join(home, ".claude.json")),
    cursor: await hasServerConfig(path.join(home, ".cursor", "mcp.json")),
  };
}

export async function probeMcp(
  token,
  { url = MCP_URL, readCatalog = readToolCatalog } = {},
) {
  if (!token) {
    return {
      ok: false,
      detail: "尚未登录",
      toolCount: 0,
      tools: [],
    };
  }

  try {
    const tools = await readCatalog({ token, url });
    return {
      ok: true,
      detail: `连接正常，tools/list 返回 ${tools.length} 个工具`,
      toolCount: tools.length,
      tools,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `连接失败：${error.message}`,
      toolCount: 0,
      tools: [],
    };
  }
}

function mark(ok) {
  return ok ? "✓" : "○";
}

export async function getStatus({
  home,
  platform = process.platform,
  env = process.env,
  url = MCP_URL,
  authUrl = AUTH_URL,
  readCatalog,
  resolveAuth = resolveAuthorization,
} = {}) {
  const authorization = await resolveAuth({ home, platform, env, authUrl });
  const configs = await inspectLocalConfiguration(home);
  const remote = await probeMcp(authorization.token, { url, readCatalog });
  return {
    credential: Boolean(authorization.token),
    credentialSource: authorization.source,
    credentialExpiresAt: authorization.expiresAt ?? null,
    credentialRefreshed: Boolean(authorization.refreshed),
    configs,
    remote,
  };
}

export async function printStatus(options = {}) {
  const result = await getStatus(options);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          credential: result.credential,
          credentialSource: result.credentialSource,
          credentialExpiresAt: result.credentialExpiresAt,
          credentialRefreshed: result.credentialRefreshed,
          configs: result.configs,
          remote: {
            ok: result.remote.ok,
            detail: result.remote.detail,
            toolCount: result.remote.toolCount,
          },
        },
        null,
        2,
      ),
    );
    return result;
  }

  console.log(
    `登录凭据          ${mark(result.credential)} ${result.credential ? `已设置（${result.credentialSource}）` : "未设置"}`,
  );
  if (result.credentialExpiresAt) {
    console.log(
      `访问令牌到期      ○ ${formatLocalDateTime(result.credentialExpiresAt)}${result.credentialRefreshed ? "（本次已自动刷新）" : ""}`,
    );
  }
  console.log(
    `Codex 配置        ${mark(result.configs.codex)} ${result.configs.codex ? "已写入" : "未发现"}`,
  );
  console.log(
    `Claude Code 配置  ${mark(result.configs.claude)} ${result.configs.claude ? "已写入" : "未发现"}`,
  );
  console.log(
    `Cursor 配置       ${mark(result.configs.cursor)} ${result.configs.cursor ? "已写入" : "未发现"}`,
  );
  console.log(
    `石榴 AI MCP       ${mark(result.remote.ok)} ${result.remote.detail}`,
  );
  return result;
}

function formatLocalDateTime(epochMillis) {
  const value = new Date(epochMillis);
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export async function printTools({
  home,
  platform = process.platform,
  env = process.env,
  url = MCP_URL,
  authUrl = AUTH_URL,
  json = false,
  readCatalog = readToolCatalog,
  resolveAuth = resolveAuthorization,
} = {}) {
  const authorization = await resolveAuth({ home, platform, env, authUrl });
  if (!authorization.token) throw new Error("尚未登录，请先运行 shiliu login");
  const tools = await readCatalog({ token: authorization.token, url });

  if (json) {
    console.log(JSON.stringify({ count: tools.length, tools }, null, 2));
    return tools;
  }

  console.log(`石榴 AI MCP 当前提供 ${tools.length} 个工具：`);
  for (const tool of tools) {
    const summary = tool.description ? ` — ${tool.description}` : "";
    console.log(`- ${tool.name}${summary}`);
  }
  return tools;
}
