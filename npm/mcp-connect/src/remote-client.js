import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { PACKAGE_VERSION } from "./constants.js";
import { closeBriefly, createRequestContext } from "./request-context.js";
import { readAllTools } from "./tool-catalog.js";

export async function connectRemote({ token, apiKey, url, signal }) {
  const authorizationToken = token || apiKey;
  if (!authorizationToken) throw new Error("Missing authorization token");
  const client = new Client({
    name: "shiliu-ai-cli",
    version: PACKAGE_VERSION,
  });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${authorizationToken}`,
      },
    },
  });
  try {
    await client.connect(transport, { timeout: 15000, signal });
  } catch (error) {
    await closeBriefly(() => client.close());
    throw error;
  }
  return client;
}

export async function readToolCatalog({
  token,
  apiKey,
  url,
  connect = connectRemote,
}) {
  const client = await connect({ token: token || apiKey, url });
  const context = createRequestContext();
  try {
    const tools = await readAllTools((_method, params) => context.run(() => client.listTools(params, context.options())),
      { deadline: context.deadline });
    client.cacheToolMetadata?.(tools);
    return tools;
  } finally {
    context.dispose();
    await closeBriefly(() => client.close());
  }
}
