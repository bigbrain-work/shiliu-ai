# Installation and connection

Use this reference only when the Shiliu AI MCP server is absent or unhealthy.

## Preferred flow

```bash
npx -y @bigbrain-work/mcp-connect login
npx -y @bigbrain-work/mcp-connect install
npx -y @bigbrain-work/mcp-connect status
```

The package also exposes `shiliu` as a command name. `mcp-connect` remains available for backward compatibility.

For a nonblocking Agent flow, start the login and follow the returned machine-readable continuation command:

```bash
shiliu login --no-wait --json
shiliu login poll --session <login_session_id> --wait --json
```

Show `verification_uri` and `user_code` to the human. Run `poll_command` only after the human confirms that WeChat authorization is complete. Never expose or request the internal device code.

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

Do not pass credentials as command-line flags because shell history and process listings can expose them. The default login displays a WeChat QR code, verifies the issued access token with `tools/list`, and stores the token set in the operating-system credential store. During the transition period, explicitly pass `--legacy-api-key` only when an existing API Key must be used.
