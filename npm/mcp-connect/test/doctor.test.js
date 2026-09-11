import assert from "node:assert/strict";
import test from "node:test";

import { getDoctorReport } from "../src/doctor.js";

function runtimeFixture() {
  return {
    state: "runtime_healthy",
    current: {
      process_node: { version: "24.0.0", path: "/node" },
      path_node: { path: "/node" },
      npm: { available: true, version: "11.0.0", path: "/npm" },
      npx: { available: true, version: "11.0.0", path: "/npx" },
      npm_global_prefix: "/global",
    },
    persistent_path_baseline: {
      available: true,
      npx: { available: true, path: "/npx" },
    },
    environment_difference: false,
    boundary: "baseline only",
  };
}

test("doctor reports local stdio verification without claiming client access", async () => {
  const report = await getDoctorReport({
    platform: "linux",
    env: {},
    collectRuntime: runtimeFixture,
    verifyLaunch: async () => ({
      state: "stdio_launch_verified",
      attempted: true,
      ok: true,
      tool_count: 26,
      detail: "ok",
    }),
  });
  assert.equal(report.status, "stdio_launch_verified");
  assert.equal(report.stdio_launch.tool_count, 26);
  assert.equal(report.client_connection.state, "unverified");
  assert.match(report.client_connection.detail, /不能证明/u);
});

test("doctor dry-run never launches stdio", async () => {
  let launches = 0;
  const report = await getDoctorReport({
    dryRun: true,
    platform: "linux",
    env: {},
    collectRuntime: runtimeFixture,
    verifyLaunch: async () => {
      launches += 1;
    },
  });
  assert.equal(launches, 0);
  assert.equal(report.stdio_launch.state, "not_attempted");
});

test("doctor reports an attempted stdio launch failure as the top-level state", async () => {
  const report = await getDoctorReport({
    collectRuntime: runtimeFixture,
    verifyLaunch: async () => ({
      state: "stdio_launch_failed",
      attempted: true,
      ok: false,
      tool_count: 0,
      detail: "npx unavailable",
    }),
  });
  assert.equal(report.status, "stdio_launch_failed");
  assert.equal(report.client_connection.state, "unverified");
});

test("doctor verifies every offered stdio candidate and reports the working one", async () => {
  const runtime = runtimeFixture();
  runtime.current.process_node.path = "C:\\sandbox\\node.exe";
  runtime.current.process_node.path_risks = ["application_managed_sandbox"];
  runtime.current.shiliu_entry = "C:\\sandbox\\bin\\shiliu.js";
  runtime.current.shiliu_entry_risks = ["application_managed_sandbox"];
  runtime.persistent_path_baseline.npx.available = false;
  const verified = [];
  const report = await getDoctorReport({
    platform: "win32",
    collectRuntime: () => runtime,
    verifyLaunch: async ({ definition }) => {
      verified.push(definition);
      const ok = definition.command === "C:\\sandbox\\node.exe";
      return {
        state: ok ? "stdio_launch_verified" : "stdio_launch_failed",
        attempted: true,
        ok,
        tool_count: ok ? 26 : 0,
        detail: ok ? "fallback works" : "standard fails",
      };
    },
  });
  assert.equal(verified.length, 2);
  assert.equal(report.status, "stdio_launch_verified");
  assert.equal(report.stdio_launch.verified_candidate, "absolute_current_install");
  assert.equal(report.candidates[1].tradeoffs.length, 3);
});
