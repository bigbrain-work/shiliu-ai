import assert from "node:assert/strict";
import test from "node:test";

import {
  connectRecoveringRemote,
  isUnauthorizedError,
} from "../src/recovering-remote.js";

function remote({ listTools, close = async () => {} }) {
  return {
    getServerCapabilities: () => ({ tools: {} }),
    listTools,
    close,
  };
}

test("recognizes the HTTP authorization errors returned by MCP transports", () => {
  assert.equal(isUnauthorizedError(new Error("HTTP 401: Unauthorized")), true);
  assert.equal(isUnauthorizedError({ statusCode: 401 }), true);
  assert.equal(
    isUnauthorizedError(new Error("outer", { cause: { response: { status: 401 } } })),
    true,
  );
  assert.equal(isUnauthorizedError(new Error("HTTP 500")), false);
});

test("reloads credentials, reconnects, and retries once after a 401", async () => {
  const closed = [];
  const first = remote({
    listTools: async () => {
      throw new Error("Error POSTing to endpoint (HTTP 401): Unauthorized");
    },
    close: async () => closed.push("first"),
  });
  const second = remote({ listTools: async () => ({ tools: ["works"] }) });
  const tokens = ["expired-token", "fresh-token"];
  const connections = [];
  const recovering = await connectRecoveringRemote({
    url: "https://example.test/mcp",
    resolveAuthorization: async () => ({ token: tokens.shift() }),
    connectRemote: async ({ token }) => {
      connections.push(token);
      return token === "expired-token" ? first : second;
    },
  });

  const result = await recovering.invoke("listTools", {});

  assert.deepEqual(result, { tools: ["works"] });
  assert.deepEqual(connections, ["expired-token", "fresh-token"]);
  assert.deepEqual(closed, ["first"]);
  await recovering.close();
});

test("concurrent 401 responses share one credential reload and reconnect", async () => {
  let releaseFailures;
  const failureGate = new Promise((resolve) => {
    releaseFailures = resolve;
  });
  const first = remote({
    listTools: async () => {
      await failureGate;
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    },
  });
  const second = remote({ listTools: async () => ({ tools: ["ok"] }) });
  let resolves = 0;
  let connects = 0;
  const recovering = await connectRecoveringRemote({
    url: "https://example.test/mcp",
    resolveAuthorization: async () => ({ token: `token-${++resolves}` }),
    connectRemote: async () => (++connects === 1 ? first : second),
  });

  const requests = [
    recovering.invoke("listTools", {}),
    recovering.invoke("listTools", {}),
  ];
  releaseFailures();
  const results = await Promise.all(requests);

  assert.deepEqual(results, [{ tools: ["ok"] }, { tools: ["ok"] }]);
  assert.equal(resolves, 2);
  assert.equal(connects, 2);
  await recovering.close();
});

test("retries credential resolution once to tolerate rotating-token races", async () => {
  const first = remote({
    listTools: async () => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    },
  });
  const second = remote({ listTools: async () => ({ tools: ["ok"] }) });
  let resolves = 0;
  const waits = [];
  const recovering = await connectRecoveringRemote({
    url: "https://example.test/mcp",
    retryDelayMs: 300,
    sleep: async (milliseconds) => waits.push(milliseconds),
    resolveAuthorization: async () => {
      resolves += 1;
      if (resolves === 2) throw new Error("refresh token already rotated");
      return { token: resolves === 1 ? "old" : "new" };
    },
    connectRemote: async ({ token }) => (token === "old" ? first : second),
  });

  const result = await recovering.invoke("listTools", {});

  assert.deepEqual(result, { tools: ["ok"] });
  assert.deepEqual(waits, [300]);
  assert.equal(resolves, 3);
  await recovering.close();
});

test("does not reconnect or retry non-authentication failures", async () => {
  const expected = new Error("upstream unavailable");
  const first = remote({ listTools: async () => Promise.reject(expected) });
  let resolves = 0;
  let connects = 0;
  const recovering = await connectRecoveringRemote({
    url: "https://example.test/mcp",
    resolveAuthorization: async () => {
      resolves += 1;
      return { token: "token" };
    },
    connectRemote: async () => {
      connects += 1;
      return first;
    },
  });

  await assert.rejects(recovering.invoke("listTools", {}), expected);
  assert.equal(resolves, 1);
  assert.equal(connects, 1);
  await recovering.close();
});

test("distinguishes an expired Shiliu login from an invalid Douyin cookie", async () => {
  const unauthorized = () => {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  };
  const recovering = await connectRecoveringRemote({
    url: "https://example.test/mcp",
    resolveAuthorization: async () => ({ token: "still-invalid" }),
    connectRemote: async () => remote({ listTools: async () => unauthorized() }),
  });

  await assert.rejects(
    recovering.invoke("listTools", {}),
    /石榴 AI 平台登录凭据已失效.*不是抖音 Cookie 失效/u,
  );
  await recovering.close();
});
