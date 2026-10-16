import { writeFile } from "node:fs/promises";
import { runProxy } from "../src/proxy.js";

if (process.env.SHILIU_LIFECYCLE_FIXTURE_URL) {
  if (process.env.SHILIU_LIFECYCLE_PID_FILE) await writeFile(process.env.SHILIU_LIFECYCLE_PID_FILE, String(process.pid));
  await runProxy({ home: process.env.SHILIU_LIFECYCLE_HOME,
    url: process.env.SHILIU_LIFECYCLE_FIXTURE_URL,
    resolveAuth: async () => ({ token: "synthetic-only" }), pollIntervalMs: 20 });
}
