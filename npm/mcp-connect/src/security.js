import { AUTH_URL, MCP_URL } from "./constants.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u;

function normalizeEndpoint(value) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) {
    throw new Error("服务地址不能包含用户名或密码");
  }
  if (parsed.hash) throw new Error("服务地址不能包含 URL 片段");
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return parsed;
}

function isSameEndpoint(actual, expected) {
  return (
    actual.protocol === expected.protocol &&
    actual.hostname === expected.hostname &&
    actual.port === expected.port &&
    actual.pathname === expected.pathname &&
    actual.search === expected.search
  );
}

function validateServiceUrl(value, expectedValue, label, { allowLocalhost }) {
  let actual;
  let expected;
  try {
    actual = normalizeEndpoint(value);
    expected = normalizeEndpoint(expectedValue);
  } catch (error) {
    throw new Error(`${label}无效：${error.message}`);
  }

  if (isSameEndpoint(actual, expected)) return actual.toString();
  if (
    allowLocalhost &&
    LOOPBACK_HOSTS.has(actual.hostname) &&
    ["http:", "https:"].includes(actual.protocol)
  ) {
    return actual.toString();
  }

  throw new Error(
    `${label}仅允许石榴 AI 正式地址；本机测试请使用回环地址并显式添加 --allow-localhost`,
  );
}

export function validateMcpUrl(value, options = {}) {
  return validateServiceUrl(value, MCP_URL, "MCP 地址", options);
}

export function validateAuthUrl(value, options = {}) {
  return validateServiceUrl(value, AUTH_URL, "授权地址", options);
}

export function normalizeDeviceUserCode(value) {
  if (typeof value !== "string" || !USER_CODE_PATTERN.test(value)) {
    throw new Error("授权服务返回的登录会话编号格式无效");
  }
  return value;
}
