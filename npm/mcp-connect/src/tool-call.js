import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { resolveAuthorization } from "./authorization.js";
import { AUTH_URL } from "./constants.js";
import { connectRemote } from "./remote-client.js";
import { connectRecoveringRemote } from "./recovering-remote.js";

const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;

async function readStdin(stream = process.stdin) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > MAX_ARGUMENT_BYTES) {
      throw new Error("stdin 参数超过 4 MiB 限制");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgumentJson(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} 不是有效 JSON：${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} 必须是 JSON 对象`);
  }
  return value;
}

export async function readToolArguments({
  argumentsJson,
  argumentsFile,
  argumentsStdin,
  stdin = process.stdin,
} = {}) {
  if (argumentsJson !== undefined) {
    return parseArgumentJson(argumentsJson, "--args");
  }
  if (argumentsFile !== undefined) {
    const absolutePath = path.resolve(argumentsFile);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new Error("--args-file 必须指向普通文件");
    if (metadata.size > MAX_ARGUMENT_BYTES) {
      throw new Error("--args-file 超过 4 MiB 限制");
    }
    return parseArgumentJson(await readFile(absolutePath, "utf8"), "--args-file");
  }
  if (argumentsStdin) {
    return parseArgumentJson(await readStdin(stdin), "--args-stdin");
  }
  return {};
}

function createValidator(schema) {
  const Constructor = /draft-0?7/iu.test(String(schema?.$schema || ""))
    ? Ajv
    : Ajv2020;
  const ajv = new Constructor({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema || { type: "object" });
}

function formatValidationErrors(errors = []) {
  return errors
    .map((error) => {
      const location = error.instancePath || "/";
      return `${location} ${error.message || error.keyword}`;
    })
    .join("; ");
}

export function validateToolArguments(tool, argumentsValue) {
  let validate;
  try {
    validate = createValidator(tool.inputSchema);
  } catch (error) {
    throw new Error(`工具 ${tool.name} 的 inputSchema 无法编译：${error.message}`);
  }
  if (!validate(argumentsValue)) {
    throw new Error(
      `工具 ${tool.name} 参数结构校验失败：${formatValidationErrors(validate.errors)}`,
    );
  }
}

function objectMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const requestId = value.request_id ?? value.requestId ?? value.id;
  return {
    request_id:
      typeof requestId === "string" || typeof requestId === "number"
        ? requestId
        : null,
    billing:
      value.billing && typeof value.billing === "object" ? value.billing : null,
  };
}

export function extractResultMetadata(result) {
  const candidates = [result?.structuredContent];
  for (const item of result?.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      candidates.push(JSON.parse(item.text));
    } catch {
      // Text content is not required to be JSON.
    }
  }
  let requestId = null;
  let billing = null;
  for (const candidate of candidates) {
    const direct = objectMetadata(candidate);
    const nested = objectMetadata(candidate?.data);
    requestId ??= direct.request_id ?? nested.request_id;
    billing ??= direct.billing ?? nested.billing;
    if (requestId !== null && billing !== null) break;
  }
  return { request_id: requestId, billing };
}

async function targetExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function preflightOutputPath(outputPath, { force = false } = {}) {
  if (!outputPath) return null;
  const absolutePath = path.resolve(outputPath);
  const directory = path.dirname(absolutePath);
  await mkdir(directory, { recursive: true });
  if (await targetExists(absolutePath)) {
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`输出路径不是普通文件：${absolutePath}`);
    }
    if (!force) {
      throw new Error(`输出文件已存在：${absolutePath}；如需覆盖请显式添加 --force`);
    }
  }
  return absolutePath;
}

export async function writeResultFile(
  outputPath,
  value,
  { force = false, write = writeFile, move = rename, remove = rm } = {},
) {
  const absolutePath = path.resolve(outputPath);
  const directory = path.dirname(absolutePath);
  await preflightOutputPath(absolutePath, { force });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.from(serialized, "utf8");
  const temporaryPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await write(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    if (force && (await targetExists(absolutePath))) {
      await remove(absolutePath, { force: true });
    }
    await move(temporaryPath, absolutePath);
  } catch (error) {
    await remove(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    path: absolutePath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function runToolCall({
  toolName,
  argumentsValue,
  dryRun = false,
  outputPath,
  force = false,
  home,
  platform = process.platform,
  env = process.env,
  url,
  authUrl = AUTH_URL,
  tokenStore,
  connect = connectRemote,
  resolveAuth = resolveAuthorization,
  connectRecovering = connectRecoveringRemote,
} = {}) {
  const preparedOutputPath = await preflightOutputPath(outputPath, { force });
  const remote = await connectRecovering({
    url,
    connectRemote: connect,
    resolveAuthorization: async () =>
      resolveAuth({ home, platform, env, authUrl, tokenStore }),
  });
  try {
    const catalog = await remote.invoke("listTools");
    const tools = catalog.tools || [];
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(
        `未找到工具 ${toolName}；请先运行 shiliu tools --json 获取实时工具名称`,
      );
    }
    validateToolArguments(tool, argumentsValue);
    if (dryRun) {
      return {
        status: "arguments_valid",
        executed: false,
        tool: toolName,
        message: "参数结构校验成功，尚未执行服务端业务调用。",
      };
    }

    const result = await remote.invoke("callTool", {
      name: toolName,
      arguments: argumentsValue,
    });
    if (!preparedOutputPath) return result;
    const file = await writeResultFile(preparedOutputPath, result, { force });
    const metadata = extractResultMetadata(result);
    return {
      status: result.isError ? "tool_error_saved" : "success",
      tool: toolName,
      output_path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      request_id: metadata.request_id,
      billing: metadata.billing,
      is_error: Boolean(result.isError),
    };
  } finally {
    await remote.close();
  }
}
