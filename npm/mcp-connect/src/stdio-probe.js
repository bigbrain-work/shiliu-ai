// Keep this diagnostic transport independent of the SDK and its dependencies.
import { spawn } from "node:child_process";
import { PACKAGE_VERSION } from "./constants.js";
import { diagnosticSummary, parseDiagnosticOutput } from "./mcp-diagnostics.js";

const LOGIN_NAMES = new Set(["shiliu_login", "shiliu_login_poll", "shiliu_connection_status"]);

export async function verifyStdioLaunch({ definition, env = process.env, timeoutMs = 30000 } = {}) {
  let child;
  let stderr = "";
  let buffer = "";
  let timeout;
  let closed = false;
  let sequence = 0;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    child = spawn(definition.command, definition.args, {
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")),
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", rejectAll);
    child.on("close", () => { closed = true; rejectAll(new Error("stdio closed")); });
    child.stdin.on("error", rejectAll);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { rejectAll(new Error("stdio response too large")); return; }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC");
          const waiting = pending.get(message.id);
          if (!waiting) continue; // notifications are not responses
          pending.delete(message.id);
          if (message.error || !("result" in message)) waiting.reject(new Error("MCP request failed"));
          else waiting.resolve(message.result);
        } catch { rejectAll(new Error("Invalid stdio JSON-RPC")); }
      }
    });
    const operation = async () => {
      const initialized = await request("initialize", {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "shiliu-ai-doctor", version: PACKAGE_VERSION },
      });
      if (!initialized?.protocolVersion || !initialized?.serverInfo) throw new Error("Invalid initialize response");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const tools = [];
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < 100; page += 1) {
        const catalog = await request("tools/list", cursor ? { cursor } : {});
        if (!Array.isArray(catalog?.tools) || catalog.tools.some((tool) => typeof tool?.name !== "string" || !tool.inputSchema)) {
          throw new Error("Invalid tools/list response");
        }
        tools.push(...catalog.tools);
        if (!catalog.nextCursor) break;
        if (cursors.has(catalog.nextCursor) || page === 99) throw new Error("Invalid tool pagination");
        cursor = catalog.nextCursor;
        cursors.add(cursor);
      }
      const bootstrapCount = tools.filter((tool) => LOGIN_NAMES.has(tool.name)).length;
      let remoteConnected = bootstrapCount === 0;
      let loginState = bootstrapCount === 0 ? "legacy_bridge" : "checking_login";
      if (tools.some((tool) => tool.name === "shiliu_connection_status")) {
        const result = await request("tools/call", { name: "shiliu_connection_status", arguments: {} });
        remoteConnected = result.structuredContent?.remote_connected === true;
        const allowedStates = new Set(["ready", "connected", "checking_login", "login_required", "auth_expired", "credential_unavailable", "remote_unavailable"]);
        loginState = allowedStates.has(result.structuredContent?.status) ? result.structuredContent.status : loginState;
      }
      return {
        state: "stdio_launch_verified", attempted: true, ok: true, tool_count: tools.length,
        ...(parseDiagnosticOutput(stderr)?.runtime ? { child_runtime: parseDiagnosticOutput(stderr).runtime } : {}),
        bootstrap_tool_count: bootstrapCount, business_tool_count: tools.length - bootstrapCount,
        remote_connected: remoteConnected, login_state: loginState,
        detail: `本机 MCP 启动验证成功，${bootstrapCount} 个登录/状态工具、${tools.length - bootstrapCount} 个业务工具；${remoteConnected ? "远程服务已连接" : "远程业务连接尚未完成"}`,
      };
    };
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("stdio timeout")), timeoutMs); }),
    ]);
  } catch (error) {
    const diagnostic = parseDiagnosticOutput(stderr) || diagnosticSummary(error.code === "ENOENT" ? "RUNTIME_UNAVAILABLE" : "PROTOCOL_ERROR", "mcp_start");
    return {
      state: "stdio_launch_failed", attempted: true, ok: false, tool_count: 0,
      error_code: diagnostic.code, error_stage: diagnostic.stage,
      process_exit_code: diagnostic.fatal ? diagnostic.exit_code : null,
      ...(diagnostic.runtime ? { child_runtime: diagnostic.runtime } : {}),
      detail: `${diagnostic.code} (${diagnostic.stage})：${diagnostic.message} ${diagnostic.action}`,
    };
  } finally {
    clearTimeout(timeout);
    rejectAll(new Error("probe complete"));
    if (child && !closed) {
      child.stdin.end();
      // cmd/npx may own a descendant. Close stdin gracefully first so the bridge can exit.
      await new Promise((resolve) => {
        const wait = setTimeout(resolve, 500);
        child.once("close", () => { clearTimeout(wait); resolve(); });
      });
      if (!closed) {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          await new Promise((resolve) => { killer.once("close", resolve); killer.once("error", resolve); });
        } else child.kill("SIGKILL");
      }
    }
  }
}
