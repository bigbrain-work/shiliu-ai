import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { connectRecoveringRemote } from "../src/recovering-remote.js";
import { connectRemote } from "../src/remote-client.js";

async function fixture(t, { rpcError, isError = false, rejectFirstHttp = false }) {
  const counts = { initializes: 0, requests: 0, executions: 0, resolves: 0 };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === "initialize") {
      counts.initializes += 1;
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "local-auth-fixture", version: "1" },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "synthetic_write", inputSchema: { type: "object" } }] };
    } else if (message.method === "tools/call") {
      counts.requests += 1;
      // Model authentication rejection BEFORE dispatch, not a business failure.
      if (rejectFirstHttp && counts.requests === 1) {
        response.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
        return;
      }
      counts.executions += 1;
      if (rpcError) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", id: message.id, error: rpcError,
        }));
        return;
      }
      result = { content: [{ type: "text", text: "downstream token invalid 401" }], isError };
    } else {
      response.writeHead(500).end("unexpected method");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      jsonrpc: "2.0", id: message.id, result,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const recovering = await connectRecoveringRemote({
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    resolveAuthorization: async () => ({ token: `synthetic-${++counts.resolves}` }),
    connectRemote,
  });
  t.after(() => recovering.close());
  return { recovering, counts };
}

for (const code of [-32603, 401]) {
  test(`actual SDK JSON-RPC ${code} with auth-looking business text executes once`, async (t) => {
    const { recovering, counts } = await fixture(t, {
      rpcError: { code, message: "downstream token invalid; HTTP 401 Unauthorized" },
    });
    await assert.rejects(recovering.invoke("callTool", { name: "synthetic_write", arguments: {} }),
      (error) => error instanceof McpError && error.code === code);
    assert.equal((await recovering.invoke("listTools", {})).tools.length, 1);
    assert.deepEqual(counts, { initializes: 1, requests: 1, executions: 1, resolves: 1 });
  });
}

test("actual SDK isError result is returned without reconnect or replay", async (t) => {
  const { recovering, counts } = await fixture(t, { isError: true });
  const result = await recovering.invoke("callTool", { name: "synthetic_write", arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(counts, { initializes: 1, requests: 1, executions: 1, resolves: 1 });
});

test("actual HTTP 401 before dispatch retains the existing one-reconnect recovery", async (t) => {
  const { recovering, counts } = await fixture(t, { rejectFirstHttp: true });
  const result = await recovering.invoke("callTool", { name: "synthetic_write", arguments: {} });
  assert.equal(result.isError, false);
  assert.deepEqual(counts, { initializes: 2, requests: 2, executions: 1, resolves: 2 });
});
