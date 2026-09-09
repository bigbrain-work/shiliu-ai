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

The CLI has already generated the QR code. Display the local PNG at `qr_code_path` directly to the human and tell them to scan it with WeChat; do not ask the Agent to generate another QR code. Do not open `verification_uri` as an ordinary web page; it is only a fallback and the QR payload. Run `poll_command` only after the human confirms that WeChat authorization is complete. The CLI removes the temporary QR image after success, rejection, or expiry. Never expose or request the internal device code.

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

Before the first Shiliu AI MCP tool call in each user task, run the throttled refresh command once:

```bash
shiliu skill refresh
```

The CLI records the last attempt per project. It returns immediately for 24 hours, and when due it invokes only `npx -y skills add https://bigbrain.work/shiliuAI -y`. The Skill is downloaded from Shiliu AI's Well-known Skills endpoint and does not require Git, GitHub access, or a local Git installation. Successful and failed attempts both enter the cooldown so a network outage does not slow every user task. Use `shiliu skill refresh --force` only when the user explicitly requests an immediate retry.

For manual diagnostics:

```bash
# Check all installed Skills without changing them
npx -y skills check
```

Do not run an unscoped `skills update`; the Shiliu refresh command owns the targeted update behavior. A changed MCP tool or field is still discovered through live `tools/list`; it does not depend on the Skill refresh. Refreshed instructions take effect in the next task or after reloading when the client does not dynamically reload the current context.

Do not pass credentials as command-line flags because shell history and process listings can expose them. The default login displays a WeChat QR code, verifies the issued access token with `tools/list`, and stores the token set in the operating-system credential store. During the transition period, explicitly pass `--legacy-api-key` only when an existing API Key must be used.
