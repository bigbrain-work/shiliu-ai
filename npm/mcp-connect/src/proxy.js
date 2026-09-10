import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveAuthorization } from "./authorization.js";
import { API_KEY_ENV, AUTH_URL, PACKAGE_VERSION } from "./constants.js";
import { connectRemote } from "./remote-client.js";
import { connectRecoveringRemote } from "./recovering-remote.js";

export async function runProxy({
  home,
  url,
  authUrl = AUTH_URL,
  platform = process.platform,
  env = process.env,
  tokenStore,
} = {}) {
  const remote = await connectRecoveringRemote({
    url,
    connectRemote,
    resolveAuthorization: async () => {
      const authorization = await resolveAuthorization({
        home,
        platform,
        env,
        authUrl,
        tokenStore,
      });
      if (!authorization.token) {
        throw new Error(
          `未找到登录凭据，请先运行 shiliu login，或设置 ${API_KEY_ENV}`,
        );
      }
      return authorization;
    },
  });
  const remoteCapabilities = remote.getServerCapabilities() ?? {};
  const capabilities = {};
  if (remoteCapabilities.tools) capabilities.tools = {};
  if (remoteCapabilities.resources) capabilities.resources = {};
  if (remoteCapabilities.prompts) capabilities.prompts = {};

  const server = new Server(
    { name: "shiliu-ai-mcp-proxy", version: PACKAGE_VERSION },
    {
      capabilities,
      instructions:
        "Authenticated stdio bridge for the Shiliu AI remote MCP service.",
    },
  );

  if (remoteCapabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, (request) =>
      remote.invoke("listTools", request.params),
    );
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      remote.invoke("callTool", request.params),
    );
  }
  if (remoteCapabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (request) =>
      remote.invoke("listResources", request.params),
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
      remote.invoke("listResourceTemplates", request.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, (request) =>
      remote.invoke("readResource", request.params),
    );
  }
  if (remoteCapabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (request) =>
      remote.invoke("listPrompts", request.params),
    );
    server.setRequestHandler(GetPromptRequestSchema, (request) =>
      remote.invoke("getPrompt", request.params),
    );
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([server.close(), remote.close()]);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await shutdown();
    throw error;
  }
}
