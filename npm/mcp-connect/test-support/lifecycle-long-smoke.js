import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectRecoveringRemote } from "../src/recovering-remote.js";

if (process.env.SHILIU_RUN_LONG_SMOKE === "1") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "65-second-local-fixture", version: "1" }, { capabilities: { tools: {} } });
  let executions = 0;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "long", inputSchema: { type: "object" } }] }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    executions += 1; await delay(65000);
    return { content: [{ type: "text", text: "local 65-second result" }] };
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "long-smoke-client", version: "1" });
  await client.connect(clientTransport);
  const remote = await connectRecoveringRemote({ resolveAuthorization: async () => ({ token: "synthetic" }), connectRemote: async () => client });
  try {
    const start = Date.now();
    const result = await remote.invoke("callTool", { name: "long", arguments: {} });
    const elapsed = Date.now() - start;
    assert.equal(result.content[0].text, "local 65-second result");
    assert.equal(executions, 1); assert.ok(elapsed >= 65000);
    console.log(JSON.stringify({ elapsedMs: elapsed, executions, defaultTimeoutPassed: true, productionCalls: 0 }));
  } finally { await remote.close(); await server.close(); }
}
