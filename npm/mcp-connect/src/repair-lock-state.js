import { readFile } from "node:fs/promises";

// Only ESRCH proves that an owner is gone. EPERM and malformed metadata fail closed.
export async function inspectRepairLock(lockPath, { kill = process.kill } = {}) {
  let text;
  try { text = await readFile(lockPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { state: "absent" }; throw error; }
  let owner;
  try { owner = JSON.parse(text); } catch { return { state: "unknown" }; }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return { state: "unknown", owner };
  try { kill(owner.pid, 0); return { state: "active", owner }; }
  catch (error) { return { state: error.code === "ESRCH" ? "stale" : "unknown", owner }; }
}
