# Installation and connection

Use this reference when Shiliu AI MCP is absent or unhealthy.

## Install or repair

Read the [canonical Agent installation guide](https://bigbrain.work/shiliuAI/install.txt) and follow its current steps. Do not infer installation steps from the product homepage or substitute an older flow. Resume at the failed stage after diagnosis; do not restart installation or clear credentials by default. Use the verified `shiliu` executable consistently.

The guide owns CLI and Skill installation, nonblocking WeChat authorization, configuration of the current Agent, and completion checks. Skill installer identifiers and Shiliu CLI adapter identifiers can differ; use the mapping in the guide.

If Skill installation is unavailable but the client supports local stdio MCP, continue MCP setup and report the missing Skill separately. Do not report full completion until the current Agent has loaded the MCP connection and can discover its live tools.

## Diagnose an existing connection

Run separately and inspect each result:

```text
shiliu --version
shiliu status
shiliu tools
```

- A missing executable is a runtime or PATH issue. Preserve the current PATH when resolving it. In Windows PowerShell, use `shiliu.cmd` when execution policy blocks the PowerShell command shim.
- CLI authentication and live tool discovery verify only the CLI connection. Inspect the current Agent's MCP connection and live catalog before reporting Agent access.
- Configuration state `generated_only` means the CLI printed a proposal but did not install it. State `written` means the target configuration was saved; reconnect when `reload_required` is true.
- Start login only when authentication is missing or explicitly rejected. Diagnose network and client-configuration failures before changing credentials.
- For a pending login, show only the current local QR image, then immediately repeat its single-shot `poll_command` at `poll_after_seconds`. The user only scans with WeChat; there is no phone confirmation button and the Agent must not wait for another user reply.
- Never request or expose access tokens, refresh tokens, internal device codes, or API keys.

## Maintenance and platform recovery
Follow the update policy in [SKILL.md](../SKILL.md); it owns targeted `shiliu skill refresh` and cooldown. Installation does not require an additional maintenance pass. Discover tool names and schemas from the live MCP catalog.

For an explicitly requested CLI version check, `shiliu update` checks npm without installing anything. Do not run an unscoped `skills update` or switch to a temporary `npx` CLI as routine repair.

On Windows, the PowerShell installer retries a failed package installation once for EBUSY/EPERM, stopping only identifiable Shiliu MCP Node processes. If it still fails, report the lock or permission error and ask the user to close affected MCP clients before another attempt. After a successful upgrade, reconnect affected clients and verify their connection.

If Codex reports an existing configuration error, address the reported field and line while preserving unrelated settings, then retry configuration. Do not replace the entire Agent configuration to fix a Shiliu connection.
