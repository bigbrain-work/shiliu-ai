import { parseArgs } from "node:util";

const COMMANDS = new Set([
  "install",
  "login",
  "logout",
  "status",
  "tools",
  "doctor",
  "repair",
  "call",
  "mcp",
  "proxy",
  "skill",
  "update",
]);

export function parseCliArguments(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "launch-file": { type: "string" },
      "node-path": { type: "string" },
      "npm-cli": { type: "string" },
      "npm-cache": { type: "string" },
      "cache-entry": { type: "string" },
      "standard-only": { type: "boolean", default: false },
      prepare: { type: "boolean", default: false },
      agent: {
        type: "string",
        short: "a",
      },
      "dry-run": {
        type: "boolean",
        default: false,
      },
      home: {
        type: "string",
      },
      url: {
        type: "string",
      },
      "auth-url": {
        type: "string",
      },
      "allow-localhost": {
        type: "boolean",
        default: false,
      },
      "legacy-api-key": {
        type: "boolean",
        default: false,
      },
      "no-wait": {
        type: "boolean",
        default: false,
      },
      wait: {
        type: "boolean",
        default: false,
      },
      force: {
        type: "boolean",
        default: false,
      },
      transport: {
        type: "string",
      },
      args: {
        type: "string",
      },
      "args-file": {
        type: "string",
      },
      "args-stdin": {
        type: "boolean",
        default: false,
      },
      out: {
        type: "string",
      },
      scope: {
        type: "string",
      },
      session: {
        type: "string",
      },
      json: {
        type: "boolean",
        default: false,
      },
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
      version: {
        type: "boolean",
        short: "v",
        default: false,
      },
    },
  });

  const command = parsed.positionals[0] || "install";
  if (!COMMANDS.has(command)) {
    throw new Error(`不支持的命令：${command}`);
  }
  const subcommand = parsed.positionals[1];
  const validSubcommand =
    (command === "login" && subcommand === "poll") ||
    (command === "skill" && ["install", "refresh"].includes(subcommand)) ||
    (command === "call" && Boolean(subcommand));
  if (
    parsed.positionals.length > 2 ||
    (subcommand && !validSubcommand) ||
    (command === "skill" && !["install", "refresh"].includes(subcommand))
  ) {
    throw new Error(`无法识别的参数：${parsed.positionals.slice(1).join(" ")}`);
  }

  const agent = parsed.values.agent?.toLowerCase();
  if (agent && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agent)) {
    throw new Error("客户端名称只能包含小写字母、数字、下划线和连字符");
  }
  const session = parsed.values.session;
  if (session && !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(session)) {
    throw new Error("登录会话编号格式无效");
  }

  const argumentSources = [
    parsed.values.args !== undefined,
    parsed.values["args-file"] !== undefined,
    parsed.values["args-stdin"],
  ].filter(Boolean).length;
  if (argumentSources > 1) {
    throw new Error("--args、--args-file 和 --args-stdin 只能选择一种");
  }
  if (command === "call" && !subcommand) {
    throw new Error("call 需要指定工具名称");
  }
  if (command === "doctor") {
    const transport = parsed.values.transport || "stdio";
    if (transport !== "stdio") {
      throw new Error("doctor 当前仅支持 --transport stdio");
    }
  }
  if (command !== "doctor" && parsed.values.transport !== undefined) {
    throw new Error("--transport 仅适用于 shiliu doctor");
  }
  const launchOptions = ["launch-file", "node-path", "npm-cli", "npm-cache", "cache-entry"];
  if (!["doctor", "repair"].includes(command) && launchOptions.some((key) => parsed.values[key] !== undefined)) {
    throw new Error("启动诊断选项仅适用于 doctor 或 repair");
  }
  if (command === "repair" && !parsed.values["cache-entry"] && !parsed.values.help) {
    throw new Error("repair 需要 --cache-entry 指定确认损坏的石榴 npx 安装目录");
  }
  if (command !== "repair" && parsed.values["cache-entry"] !== undefined) {
    throw new Error("--cache-entry 仅适用于 repair");
  }
  if (parsed.values["standard-only"] && command !== "doctor") throw new Error("--standard-only 仅适用于 doctor");
  if (parsed.values.prepare && command !== "doctor") throw new Error("--prepare 仅适用于 doctor");
  if (command !== "call" && argumentSources > 0) {
    throw new Error("参数输入选项仅适用于 shiliu call");
  }
  if (command !== "call" && parsed.values.out !== undefined) {
    throw new Error("--out 仅适用于 shiliu call");
  }
  if (command === "call" && parsed.values["dry-run"] && parsed.values.out) {
    throw new Error("--dry-run 不会产生业务结果，不能同时使用 --out");
  }
  if (command === "call" && parsed.values.force && !parsed.values.out) {
    throw new Error("shiliu call 的 --force 仅能与 --out 一起使用");
  }
  const skillScope = parsed.values.scope;
  if (skillScope && !["project", "user"].includes(skillScope)) {
    throw new Error("Skill 安装范围只能是 project 或 user");
  }
  if (
    parsed.values.scope !== undefined &&
    !(command === "skill" && subcommand === "install")
  ) {
    throw new Error("--scope 仅适用于 shiliu skill install");
  }
  if (command === "skill" && subcommand === "install" && !agent) {
    throw new Error("shiliu skill install 需要 --agent <Skill客户端标识>");
  }
  if (command === "skill" && subcommand === "refresh" && agent) {
    throw new Error("Skill 刷新会使用已记录目标，不接受 --agent");
  }

  return {
    ...(["doctor", "repair"].includes(command) ? {
      launchFile: parsed.values["launch-file"], nodePath: parsed.values["node-path"],
      npmCli: parsed.values["npm-cli"], npmCache: parsed.values["npm-cache"], cacheEntry: parsed.values["cache-entry"],
      standardOnly: parsed.values["standard-only"],
      prepare: parsed.values.prepare,
    } : {}),
    command,
    subcommand,
    agent,
    dryRun: parsed.values["dry-run"],
    home: parsed.values.home,
    url: parsed.values.url,
    authUrl: parsed.values["auth-url"],
    allowLocalhost: parsed.values["allow-localhost"],
    legacyApiKey: parsed.values["legacy-api-key"],
    noWait: parsed.values["no-wait"],
    wait: parsed.values.wait,
    force: parsed.values.force,
    transport: parsed.values.transport || "stdio",
    toolName: command === "call" ? subcommand : undefined,
    argumentsJson: parsed.values.args,
    argumentsFile: parsed.values["args-file"],
    argumentsStdin: parsed.values["args-stdin"],
    outputPath: parsed.values.out,
    skillScope: skillScope || "project",
    session,
    json: parsed.values.json,
    help: parsed.values.help,
    version: parsed.values.version,
  };
}
