import { REQUEST_TOTAL_TIMEOUT_MS } from "./request-context.js";

export async function readAllTools(invoke, options = {}, revision = () => undefined) {
  const deadline = options.deadline ?? Date.now() + REQUEST_TOTAL_TIMEOUT_MS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = revision();
    const tools = await readPages(invoke, { ...options, deadline });
    if (before === revision()) return tools;
  }
  throw new Error("Tool catalog connection changed repeatedly");
}

async function readPages(invoke, options) {
  const tools = [];
  const cursors = new Set();
  const request = { ...options, deadline: options.deadline ?? Date.now() + REQUEST_TOTAL_TIMEOUT_MS };
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const result = await invoke("listTools", cursor ? { cursor } : undefined, request);
    tools.push(...(result.tools || []));
    if (!result.nextCursor) return tools;
    if (cursors.has(result.nextCursor)) throw new Error("Repeated tool cursor");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Too many tool catalog pages");
}
