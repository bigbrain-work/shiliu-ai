import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractResultMetadata,
  readToolArguments,
  runToolCall,
  validateToolArguments,
  writeResultFile,
} from "../src/tool-call.js";

const exampleTool = {
  name: "example",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
};

function remoteHarness(result = { content: [{ type: "text", text: "ok" }] }) {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() {
      return closed;
    },
    connectRecovering: async () => ({
      async invoke(method, params) {
        calls.push({ method, params });
        if (method === "listTools") return { tools: [exampleTool] };
        return result;
      },
      async close() {
        closed = true;
      },
    }),
  };
}

test("reads tool arguments from stdin and files", async () => {
  assert.deepEqual(
    await readToolArguments({
      argumentsStdin: true,
      stdin: Readable.from(['{"query":"stdin"}']),
    }),
    { query: "stdin" },
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-call-args-"));
  try {
    const file = path.join(root, "args.json");
    await writeFile(file, '{"query":"file"}', "utf8");
    assert.deepEqual(await readToolArguments({ argumentsFile: file }), {
      query: "file",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates arguments with the live tool input schema", () => {
  validateToolArguments(exampleTool, { query: "works" });
  assert.throws(
    () => validateToolArguments(exampleTool, { query: 42 }),
    /参数结构校验失败/u,
  );
});

test("dry-run validates but does not call the paid tool", async () => {
  const harness = remoteHarness();
  const result = await runToolCall({
    toolName: "example",
    argumentsValue: { query: "check" },
    dryRun: true,
    url: "https://example.test/mcp",
    connectRecovering: harness.connectRecovering,
  });
  assert.equal(result.status, "arguments_valid");
  assert.deepEqual(harness.calls.map((call) => call.method), ["listTools"]);
  assert.equal(harness.closed, true);
});

test("writes a complete result atomically and returns a compact receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-call-out-"));
  const output = path.join(root, "result.json");
  const toolResult = {
    structuredContent: {
      data: { request_id: "request-1" },
      billing: { charged_points: 5 },
    },
    content: [{ type: "text", text: "large result" }],
  };
  const harness = remoteHarness(toolResult);
  try {
    const receipt = await runToolCall({
      toolName: "example",
      argumentsValue: { query: "save" },
      outputPath: output,
      url: "https://example.test/mcp",
      connectRecovering: harness.connectRecovering,
    });
    assert.equal(receipt.status, "success");
    assert.equal(receipt.output_path, output);
    assert.equal(receipt.request_id, "request-1");
    assert.equal(receipt.billing.charged_points, 5);
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), toolResult);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an existing output before invoking the paid tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-call-existing-"));
  const output = path.join(root, "result.json");
  const harness = remoteHarness();
  try {
    await writeFile(output, "existing", "utf8");
    await assert.rejects(
      runToolCall({
        toolName: "example",
        argumentsValue: { query: "do not charge" },
        outputPath: output,
        url: "https://example.test/mcp",
        connectRecovering: harness.connectRecovering,
      }),
      /输出文件已存在/u,
    );
    assert.deepEqual(harness.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes the temporary file when finalizing an output fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-call-cleanup-"));
  const output = path.join(root, "result.json");
  try {
    await assert.rejects(
      writeResultFile(output, { ok: true }, {
        move: async () => {
          throw new Error("simulated rename failure");
        },
      }),
      /simulated rename failure/u,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("combines top-level billing with a nested request id", () => {
  assert.deepEqual(
    extractResultMetadata({
      structuredContent: {
        billing: { points: 5 },
        data: { request_id: "nested-request" },
      },
    }),
    { request_id: "nested-request", billing: { points: 5 } },
  );
});

test("combines request and billing metadata from separate MCP content blocks", () => {
  assert.deepEqual(
    extractResultMetadata({
      structuredContent: { data: { request_id: "request-separated" } },
      content: [
        {
          type: "text",
          text: JSON.stringify({ billing: { consumed_credits: 5 } }),
        },
      ],
    }),
    {
      request_id: "request-separated",
      billing: { consumed_credits: 5 },
    },
  );
});
