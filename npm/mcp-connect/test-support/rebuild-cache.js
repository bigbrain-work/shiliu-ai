import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const entry = process.argv[2];
const root = path.join(entry, "node_modules/@bigbrain-work/mcp-connect");
mkdirSync(root, { recursive: true });
writeFileSync(path.join(entry, "package.json"), JSON.stringify({ dependencies: { "@bigbrain-work/mcp-connect": "1.3.10" } }));
writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@bigbrain-work/mcp-connect" }));
