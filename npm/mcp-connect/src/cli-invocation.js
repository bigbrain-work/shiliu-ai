export const CLI_OPTIONS = {
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
      "target-dir": {
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
};

// Use the same option definitions as strict parsing, even when an invalid argument
// prevents parsing. Option values must never select MCP mode or JSON output.
export function inspectCliInvocation(args) {
  let command;
  let json = false;
  let positionalOnly = false;
  const shorts = Object.fromEntries(Object.entries(CLI_OPTIONS)
    .filter(([, option]) => option.short)
    .map(([, option]) => [option.short, option]));
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
    } else if (!positionalOnly && argument.startsWith("--")) {
      const name = argument.slice(2).split("=", 1)[0];
      if (name === "json") json = true;
      if (CLI_OPTIONS[name]?.type === "string" && !argument.includes("=") &&
          isOptionValue(args[index + 1])) index += 1;
    } else if (!positionalOnly && argument.startsWith("-") && argument !== "-") {
      for (const [offset, short] of [...argument.slice(1)].entries()) {
        if (shorts[short]?.type === "string") {
          if (offset === argument.length - 2 && isOptionValue(args[index + 1])) index += 1;
          break;
        }
      }
    } else if (command === undefined) {
      command = argument;
    }
  }
  return { command: command || "install", json };
}

function isOptionValue(value) {
  return value !== undefined && (value === "-" || !value.startsWith("-"));
}

