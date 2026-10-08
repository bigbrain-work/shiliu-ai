import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { PACKAGE_VERSION } from "./constants.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REASONS = new Set(["RUNTIME_READY", "REPAIR_IN_PROGRESS", "NODE_VERSION_UNSUPPORTED", "DEPENDENCY_INCOMPLETE", "NATIVE_DEPENDENCY_UNAVAILABLE", "RUNTIME_LOAD_FAILED"]);
const ERROR_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ENOENT", "ENOEXEC"]);
const MODULE_IDS = ["ajv/dist/2020.js", "ajv/dist/2019.js", "@modelcontextprotocol/sdk", "@napi-rs/keyring", "ajv-formats", "ajv", "qrcode", "zod", "src/cli.js"];

export function safeRuntimeDetails(value) {
  if (!value || typeof value !== "object") return undefined;
  const safePath = (candidate) => typeof candidate === "string" && candidate.length < 4096 && path.isAbsolute(candidate) && !/[\r\n\0]/u.test(candidate) ? candidate : undefined;
  return {
    reason: REASONS.has(value.reason) ? value.reason : "RUNTIME_LOAD_FAILED",
    node_version: /^\d+\.\d+\.\d+$/u.test(value.node_version || "") ? value.node_version : undefined,
    node_path: safePath(value.node_path), install_root: safePath(value.install_root),
    package_version: /^\d+\.\d+\.\d+$/u.test(value.package_version || "") ? value.package_version : undefined,
    original_error_code: ERROR_CODES.has(value.original_error_code) ? value.original_error_code : undefined,
    missing_module: MODULE_IDS.includes(value.missing_module) ? value.missing_module : undefined,
  };
}

export function runtimeFailureDetails(error, nodeVersion = process.versions.node) {
  const message = String(error?.message || "").replaceAll("\\", "/");
  const missing = ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ENOENT"].includes(error?.code);
  return safeRuntimeDetails({
    reason: error?.runtimeReason || (missing ? "DEPENDENCY_INCOMPLETE" : error?.code === "ERR_DLOPEN_FAILED" ? "NATIVE_DEPENDENCY_UNAVAILABLE" : "RUNTIME_LOAD_FAILED"),
    node_version: nodeVersion, node_path: process.execPath, install_root: ROOT,
    package_version: PACKAGE_VERSION, original_error_code: error?.code,
    missing_module: missing ? MODULE_IDS.find((id) => message.includes(id)) : undefined,
  });
}

export function runtimeIdentity() {
  return safeRuntimeDetails({ reason: "RUNTIME_READY", node_version: process.versions.node,
    node_path: process.execPath, install_root: ROOT, package_version: PACKAGE_VERSION });
}

export async function checkRepairLock(env = process.env) {
  const entry = path.resolve(ROOT, "../../..");
  if (path.basename(path.dirname(entry)) !== "_npx") return;
  const cache = path.dirname(path.dirname(entry));
  try {
    const text = await readFile(path.join(cache, ".shiliu-mcp-repair.lock"), "utf8");
    const owner = JSON.parse(text);
    if (owner.probe_id && owner.probe_id === env.SHILIU_REPAIR_PROBE_ID) return;
    const error = Object.assign(new Error("repair in progress"), { code: "ENOENT", runtimeReason: "REPAIR_IN_PROGRESS" });
    throw error;
  } catch (error) {
    if (error.code === "ENOENT" && !error.runtimeReason) return;
    throw error;
  }
}
