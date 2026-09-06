import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  API_KEY_ENV,
  MCP_URL,
  PACKAGE_NAME,
  SERVER_NAME,
} from "./constants.js";
import { readPersistedApiKey } from "./credentials.js";
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
  apiKey,
  { url = MCP_URL, readCatalog = readToolCatalog } = {},
) {
  if (!apiKey) {
    return {
      ok: false,
      detail: `${API_KEY_ENV} 尚未设置`,
      toolCount: 0,
      tools: [],
    };
  }

  try {
    const tools = await readCatalog({ apiKey, url });
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
  readCatalog,
} = {}) {
  const apiKey = readPersistedApiKey({ platform, env, home });
  const configs = await inspectLocalConfiguration(home);
  const remote = await probeMcp(apiKey, { url, readCatalog });
  return { credential: Boolean(apiKey), configs, remote };
}

export async function printStatus(options = {}) {
  const result = await getStatus(options);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          credential: result.credential,
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
    `登录凭据          ${mark(result.credential)} ${result.credential ? "已设置" : "未设置"}`,
  );
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

export async function printTools({
  home,
  platform = process.platform,
  env = process.env,
  url = MCP_URL,
  json = false,
  readCatalog = readToolCatalog,
} = {}) {
  const apiKey = readPersistedApiKey({ platform, env, home });
  if (!apiKey) throw new Error("尚未登录，请先运行 shiliu login");
  const tools = await readCatalog({ apiKey, url });

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
