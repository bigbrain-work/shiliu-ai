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

  if (parsed.positionals.length > 1) {
    throw new Error(`无法识别的参数：${parsed.positionals.slice(1).join(" ")}`);
  }

  const command = parsed.positionals[0] || "install";
  if (!COMMANDS.has(command)) {
    throw new Error(`不支持的命令：${command}`);
  }

  const agent = parsed.values.agent?.toLowerCase();
  if (agent && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agent)) {
    throw new Error("客户端名称只能包含小写字母、数字、下划线和连字符");
  }

  return {
    command,
    agent,
    dryRun: parsed.values["dry-run"],
    home: parsed.values.home,
    url: parsed.values.url,
    json: parsed.values.json,
    help: parsed.values.help,
    version: parsed.values.version,
  };
}
