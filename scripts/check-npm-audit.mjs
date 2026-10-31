#!/usr/bin/env node
// Fails on any npm audit advisory of moderate severity or higher, except reviewed exceptions.
// Usage: npm audit --json > audit.json || true; node scripts/check-npm-audit.mjs audit.json
import { readFile } from "node:fs/promises";

// Each exception states why it cannot affect the CLI and when it must be removed.
const ALLOWED = new Map([
  [
    "GHSA-rmxm-3fg6-px4f",
    "@hono/node-server serveStatic path decoding. The CLI only uses the MCP SDK client; the SDK's HTTP " +
      "server code is never loaded. The fix (2.x) requires Node >= 20 while the CLI supports Node >= 18.14.1. " +
      "Remove this exception when the minimum Node version is raised.",
  ],
]);
const SEVERITY = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/check-npm-audit.mjs <npm-audit.json>");
  process.exit(2);
}
const report = JSON.parse(await readFile(file, "utf8"));
if (report.error || !report.vulnerabilities) {
  console.error("npm audit did not produce a report:", report.error?.summary ?? "missing vulnerabilities");
  process.exit(1);
}

const blocking = [];
const allowed = new Set();
for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  for (const advisory of vulnerability.via ?? []) {
    // String entries point at another vulnerable package; its own advisory is checked there.
    if (typeof advisory !== "object" || (SEVERITY[advisory.severity] ?? 4) < SEVERITY.moderate) continue;
    const id = String(advisory.url ?? "").split("/").pop();
    if (ALLOWED.has(id)) allowed.add(id);
    else blocking.push(`${name}: ${advisory.title} (${advisory.url}) [${advisory.severity}]`);
  }
}
for (const id of allowed) console.log(`Allowed ${id}: ${ALLOWED.get(id)}`);
if (blocking.length > 0) {
  console.error(`Blocking npm audit advisories:\n${blocking.join("\n")}`);
  process.exit(1);
}
console.log("npm audit: no blocking advisories.");
