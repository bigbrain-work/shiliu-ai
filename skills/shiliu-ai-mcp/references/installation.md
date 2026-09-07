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
npx -y @bigbrain-work/mcp-connect update
```

`status` checks the local configuration and performs an authenticated MCP connection plus live tool discovery. `tools` prints the current catalog returned by `tools/list`.

`update` checks the installed CLI against npm and prints the upgrade command when a newer CLI exists. It does not update Agent Skills.

## Skill updates

Do not check or update Skills during ordinary Shiliu AI tasks. A changed MCP tool or field is discovered through live `tools/list` and does not require a Skill update.

Only after the user explicitly asks:

```bash
# Check all installed Skills without changing them
npx -y skills check

# Update only the Shiliu AI Skill
npx -y skills update shiliu-ai-mcp -y
```

Do not run an unscoped `skills update` unless the user explicitly asks to update all installed Skills. Reload or reopen the Agent session after an actual Skill update when the client does not dynamically reload instructions.

Do not pass credentials as command-line flags because shell history and process listings can expose them. The default login displays a WeChat QR code, verifies the issued access token with `tools/list`, and stores the token set in the operating-system credential store. During the transition period, explicitly pass `--legacy-api-key` only when an existing API Key must be used.
