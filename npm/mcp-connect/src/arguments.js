import { parseArgs } from "node:util";

const COMMANDS = new Set([
  "install",
  "login",
  "logout",
  "status",
  "tools",
  "mcp",
  "proxy",
  "update",
]);

export function parseCliArguments(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
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
  if (
    parsed.positionals.length > 2 ||
    (subcommand && !(command === "login" && subcommand === "poll"))
  ) {
    throw new Error(`无法识别的参数：${parsed.positionals.slice(1).join(" ")}`);
  }

  const agent = parsed.values.agent?.toLowerCase();
  if (agent && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agent)) {
    throw new Error("客户端名称只能包含小写字母、数字、下划线和连字符");
  }
  const session = parsed.values.session;
  if (session && !/^[A-Za-z0-9_-]{4,128}$/u.test(session)) {
    throw new Error("登录会话编号格式无效");
  }

  return {
    command,
    subcommand,
    agent,
    dryRun: parsed.values["dry-run"],
    home: parsed.values.home,
    url: parsed.values.url,
    authUrl: parsed.values["auth-url"],
    legacyApiKey: parsed.values["legacy-api-key"],
    noWait: parsed.values["no-wait"],
    wait: parsed.values.wait,
    session,
    json: parsed.values.json,
    help: parsed.values.help,
    version: parsed.values.version,
  };
}
