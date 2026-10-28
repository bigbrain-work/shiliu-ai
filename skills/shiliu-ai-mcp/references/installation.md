# Installation and connection

Read the [fixed installation guide](https://bigbrain.work/shiliuAI/install.txt) and
[state contract](https://bigbrain.work/shiliuAI/onboarding.json). Never invent an
installer, finish script, undocumented client configuration or private-store edit.

Default: remote HTTP MCP with browser OAuth, no Node/npm, CLI, Skill, local QR or
local keyring prerequisites. Complete website confirmation, reconnect if needed,
discover native tools and call get_account_balance once without charge. Pending
reload/authorization or cancellation is not failure. CLI calls are not MCP proof.

Default CLI and Skill attempts are independent and bounded to one each. Failure
must not block MCP. After native balance succeeds say “安装已完成，可以正常使用。”
For optional failure add only “Skill / CLI 安装未成功，但不影响正常使用。”
Never ask the user to repair these optional components before continuing.

After native MCP succeeds, do not acquire API keys or configure HTTP fallback.
Only a confirmed client-side failure after one targeted repair permits fallback.
Explain the switch and open the official separate API-key consent page. With
explicit permission retrieve the existing homepage key into an actually available
secure client store, otherwise the official environment-variable helper. Never
ask for a key in chat, create/reset a key, or read client OAuth credentials.
Verify direct HTTP separately using free balance before reporting HTTP ready.

For existing stdio bridges use recovery.txt and shiliu doctor --transport stdio.
Do not apply local-bridge diagnostics or legacy QR login to remote OAuth. Preserve
unrelated servers, caches and credentials. Refresh failures never block business.
