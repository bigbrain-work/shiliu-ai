import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { PACKAGE_VERSION } from "./constants.js";

export async function connectRemote({ token, apiKey, url }) {
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
    await client.connect(transport, { timeout: 15000 });
  } catch (error) {
    await client.close().catch(() => {});
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
  try {
    const result = await client.listTools();
    return result.tools || [];
  } finally {
    await client.close();
  }
}
