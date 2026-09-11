import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessPathRisk,
  collectRuntimeDiagnostics,
  resolveExecutable,
} from "../src/runtime-diagnostics.js";

test("resolves Windows executable shims from a supplied PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-runtime-"));
  try {
    const executable = path.join(root, "npx.CMD");
    await writeFile(executable, "@echo off\r\n", "ascii");
    assert.equal(
      resolveExecutable("npx", {
        platform: "win32",
        env: { PATH: root, PATHEXT: ".EXE;.CMD" },
      }),
      executable,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks sandbox and content-addressed paths as hints, not conclusions", async () => {
  const target = path.join(
    "C:\\Users\\Example\\AppData\\Local\\Client\\User Data",
    "sandbox_runtime",
    "bases",
    "c98c5042338ed152c6f10ecd8591889f",
    "node",
    "node.exe",
  );
  assert.deepEqual(assessPathRisk(target, { platform: "win32" }), [
    "application_managed_sandbox",
    "content_addressed_path_hint",
  ]);
});

test("reports current and persistent PATH results without equating them to a client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-runtime-report-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    for (const name of ["node.EXE", "npm.CMD", "npx.CMD"]) {
      await writeFile(path.join(bin, name), "stub", "ascii");
    }
    const invocations = [];
    const spawnImpl = (command, args) => {
      invocations.push({ command, args });
      if (command === "reg.exe") {
        return { status: 1, stdout: "", stderr: "missing" };
      }
      if (args.includes("prefix")) {
        return { status: 0, stdout: `${root}\n`, stderr: "" };
      }
      return { status: 0, stdout: "1.0.0\n", stderr: "" };
    };
    const report = collectRuntimeDiagnostics({
      platform: "win32",
      env: { PATH: bin, PATHEXT: ".EXE;.CMD", ComSpec: "cmd.exe" },
      execPath: path.join(bin, "node.EXE"),
      argv: ["node", path.join(root, "shiliu.js")],
      spawnImpl,
    });
    assert.equal(report.state, "runtime_healthy");
    assert.equal(report.persistent_path_baseline.available, false);
    assert.match(report.boundary, /不代表目标 Agent/u);
    assert.ok(
      invocations.some(
        ({ command, args }) =>
          command === "cmd.exe" &&
          args[3] === "call" &&
          args[4] === path.join(bin, "npx.CMD") &&
          args[5] === "--version",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
