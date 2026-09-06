# Installation and connection

Use this reference only when the Shiliu AI MCP server is absent or unhealthy.

## Preferred flow

```bash
npx -y @bigbrain-work/mcp-connect login
npx -y @bigbrain-work/mcp-connect install
npx -y @bigbrain-work/mcp-connect status
```

The package also exposes `shiliu` as a command name. `mcp-connect` remains available for backward compatibility.

## Target one Agent

```bash
npx -y @bigbrain-work/mcp-connect install --agent codex
```

Known adapters configure Codex, Claude Code, and Cursor. For an unknown Agent name, the CLI prints a standard stdio MCP definition instead of rejecting the name.

## Diagnostics

```bash
npx -y @bigbrain-work/mcp-connect status
npx -y @bigbrain-work/mcp-connect tools
```

`status` checks the local configuration and performs an authenticated MCP connection plus live tool discovery. `tools` prints the current catalog returned by `tools/list`.

Do not pass credentials as command-line flags because shell history and process listings can expose them. During the transition period, `login` accepts a hidden terminal prompt or the `SHILIU_AI_API_KEY` environment variable. Device-code login will replace this after the matching backend flow is released.
