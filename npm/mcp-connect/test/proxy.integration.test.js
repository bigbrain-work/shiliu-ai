import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { API_KEY_ENV } from "../src/constants.js";
import { stdioServerDefinition } from "../src/configurators.js";

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createRemoteMcp() {
  const sessions = new Map();
  const httpServer = createHttpServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer integration-secret") {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    const body =
      request.method === "POST" ? await readJsonBody(request) : undefined;
    const sessionId = request.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session && request.method === "POST" && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, { transport, server }),
      });
      const server = new Server(
        { name: "mock-shiliu", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "echo",
            description: "Echo a value",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (toolRequest) => ({
        content: [
          { type: "text", text: `echo:${toolRequest.params.arguments.value}` },
        ],
      }));
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }
    if (!session) {
      response.writeHead(400).end("Invalid session");
      return;
    }
    await session.transport.handleRequest(request, response, body);
  });

  return {
    httpServer,
    sessions,
    async close() {
      await Promise.allSettled(
        [...sessions.values()].flatMap((session) => [
          session.transport.close(),
          session.server.close(),
        ]),
      );
      await new Promise((resolveClose) => httpServer.close(resolveClose));
    },
  };
}

test(
  "bridges tools/list and calls over authenticated stdio",
  { timeout: 15000 },
  async () => {
    const remote = createRemoteMcp();
    await new Promise((resolveListen) =>
      remote.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const address = remote.httpServer.address();
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve("test-support/proxy-entry.js"),
        url,
      ],
      env: { ...process.env, [API_KEY_ENV]: "integration-secret" },
      stderr: "pipe",
    });
    const client = new Client({ name: "proxy-e2e-test", version: "1.0.0" });
    let childStderr = "";
    transport.stderr?.setEncoding("utf8");
    transport.stderr?.on("data", (chunk) => {
      childStderr += chunk;
    });

    try {
      try {
        await client.connect(transport);
      } catch (error) {
        throw new Error(
          `${error.message}${childStderr ? `; child stderr: ${childStderr.trim()}` : ""}`,
          { cause: error },
        );
      }
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ["echo"],
      );
      const result = await client.callTool({
        name: "echo",
        arguments: { value: "works" },
      });
      assert.equal(result.content[0].text, "echo:works");
    } finally {
      await client.close();
      await remote.close();
    }
  },
);

test(
  "Windows cmd shim preserves duplex MCP stdio",
  { timeout: 15000, skip: process.platform !== "win32" },
  async () => {
    const remote = createRemoteMcp();
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "shiliu-stdio-"));
    await new Promise((resolveListen) =>
      remote.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const address = remote.httpServer.address();
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const npxShim = path.join(sandbox, "npx.cmd");
    await writeFile(
      npxShim,
      [
        "@echo off",
        '"%SHILIU_TEST_NODE%" "%SHILIU_TEST_PROXY_ENTRY%" "%SHILIU_TEST_MCP_URL%"',
        "",
      ].join("\r\n"),
      "ascii",
    );
    const definition = stdioServerDefinition("win32");
    const transport = new StdioClientTransport({
      command: definition.command,
      args: definition.args,
      env: {
        ...process.env,
        PATH: `${sandbox};${process.env.PATH || ""}`,
        [API_KEY_ENV]: "integration-secret",
        SHILIU_TEST_NODE: process.execPath,
        SHILIU_TEST_PROXY_ENTRY: path.resolve("test-support/proxy-entry.js"),
        SHILIU_TEST_MCP_URL: url,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "windows-stdio-test", version: "1.0.0" });
    let childStderr = "";
    transport.stderr?.setEncoding("utf8");
    transport.stderr?.on("data", (chunk) => {
      childStderr += chunk;
    });

    try {
      try {
        await client.connect(transport);
      } catch (error) {
        throw new Error(
          `${error.message}${childStderr ? `; child stderr: ${childStderr.trim()}` : ""}`,
          { cause: error },
        );
      }
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ["echo"]);
      const result = await client.callTool({
        name: "echo",
        arguments: { value: "windows-cmd" },
      });
      assert.equal(result.content[0].text, "echo:windows-cmd");
    } finally {
      await client.close();
      await remote.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  },
);
