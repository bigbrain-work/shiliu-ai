import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { PACKAGE_VERSION } from "./constants.js";

export async function connectRemote({ apiKey, url }) {
  const client = new Client({
    name: "shiliu-ai-cli",
    version: PACKAGE_VERSION,
  });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });
  await client.connect(transport);
  return client;
}

export async function readToolCatalog({
  apiKey,
  url,
  connect = connectRemote,
}) {
  const client = await connect({ apiKey, url });
  try {
    const result = await client.listTools();
    return result.tools || [];
  } finally {
    await client.close();
  }
}
