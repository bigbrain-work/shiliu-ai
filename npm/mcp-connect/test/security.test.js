import assert from "node:assert/strict";
import test from "node:test";

import { AUTH_URL, MCP_URL } from "../src/constants.js";
import {
  normalizeDeviceUserCode,
  validateAuthUrl,
  validateMcpUrl,
} from "../src/security.js";

test("accepts only the official production service endpoints by default", () => {
  assert.equal(validateMcpUrl(MCP_URL), MCP_URL);
  assert.equal(validateAuthUrl(AUTH_URL), AUTH_URL);
  assert.throws(
    () => validateMcpUrl("https://attacker.example/mcp"),
    /仅允许石榴 AI 正式地址/u,
  );
  assert.throws(
    () => validateAuthUrl("http://api.bigbrain.work/shiliu/auth/device"),
    /仅允许石榴 AI 正式地址/u,
  );
});

test("allows only explicit loopback test endpoints", () => {
  const loopback = "http://127.0.0.1:43123/mcp";
  assert.throws(() => validateMcpUrl(loopback), /--allow-localhost/u);
  assert.equal(
    validateMcpUrl(loopback, { allowLocalhost: true }),
    loopback,
  );
  assert.equal(
    validateAuthUrl("http://localhost:43124/auth", {
      allowLocalhost: true,
    }),
    "http://localhost:43124/auth",
  );
  assert.throws(
    () =>
      validateMcpUrl("http://192.168.1.8:43123/mcp", {
        allowLocalhost: true,
      }),
    /仅允许石榴 AI 正式地址/u,
  );
  assert.throws(
    () =>
      validateMcpUrl("http://user:pass@127.0.0.1:43123/mcp", {
        allowLocalhost: true,
      }),
    /不能包含用户名或密码/u,
  );
});

test("accepts only canonical device user codes", () => {
  assert.equal(normalizeDeviceUserCode("ABCD-2345"), "ABCD-2345");
  for (const unsafe of [
    "ABCD-2345 && calc",
    "$(calc)",
    "abcd-2345",
    "ABCI-2345",
    "ABCD_2345",
  ]) {
    assert.throws(
      () => normalizeDeviceUserCode(unsafe),
      /登录会话编号格式无效/u,
    );
  }
});
