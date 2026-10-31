# Installation and connection

First check for an existing shiliu_mcp entry. If one exists (stdio bridge or remote),
keep its configuration unchanged: never add, replace, remove or convert it, never
restart valid authorization or use HTTP fallback/API-key collection for it.
An existing remote OAuth entry that explicitly requires sign-in may authenticate
through its current client; an existing stdio bridge keeps its original login.
`codex mcp add` overwrites same-name entries.
Verify with native get_account_balance; a failing stdio bridge follows
[recovery.txt](https://bigbrain.work/shiliuAI/recovery.txt) and the existing
[stdio guide](https://bigbrain.work/shiliuAI/install-stdio.txt) with its original login.

For a new installation, read the [fixed installation guide](https://bigbrain.work/shiliuAI/install.txt) and
[state contract](https://bigbrain.work/shiliuAI/onboarding.json). Never invent an
installer, finish script, undocumented client configuration or private-store edit.

Default: remote HTTP MCP with browser OAuth, no Node/npm, CLI, Skill, local QR or
local keyring prerequisites. Complete website confirmation, reconnect if needed,
discover native tools and call get_account_balance once without charge. Pending
reload/authorization or cancellation is not failure. CLI calls are not MCP proof.

Follow install.txt section 2's client-specific authorization route. For Codex with
CLI access, the Agent starts `codex mcp login shiliu_mcp` when sign-in is required;
do not default to sending the user into settings. Do not repeat a flow already
completed during add. WorkBuddy and Doubao Work may require the user to confirm
installation or click Connect / 去授权 in their connector interface before the
browser opens. Use only an action actually available in that client. Do not invent
configuration paths or equate ordinary Doubao chat with Doubao Work connectors.
Reuse the client's complete authorization request; never construct a bare consent
URL or manually handle PKCE/callback credentials. Keep unknown error stages unknown.

Attempt OAuth once. If it fails (helper state `oauth_failed`; cancellation is not
failure), tell the user and switch to the personal URL in install.txt section 2b:
`https://api.bigbrain.work/shiliu/mcp/k/<API Key>`. With a CLI run the fixed helper
with `-UsePersonalUrl` (Windows) or `--use-personal-url` (macOS/Linux); it uses the
website consent page and verifies before writing. UI-configured clients: the user
copies the key from the website account page and fills the address. Never print the
address or ask for the key in chat. A personal-URL entry that offers only
`shiliu_reconnect` means the key was reset: follow recovery.txt "专属地址失效".

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
