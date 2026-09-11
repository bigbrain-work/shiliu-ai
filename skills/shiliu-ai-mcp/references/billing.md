# Billing behavior

Pricing can change. Do not hardcode point rates from this file or from memory.

- Use the live tool description, product information returned by the service, or a dedicated balance/billing tool as the current source of truth.
- If the user asks for a potentially expensive batch, estimate only when the live service exposes enough information. Otherwise say that the exact charge is determined by the service.
- Do not call a paid data or media tool merely to test whether it works. Use CLI health checks and `tools/list` for non-billable diagnostics.
- For per-item tools, avoid requesting duplicate records and stop pagination at the requested count.
- Reuse complete paid results that remain accessible. If a result was lost, truncated, or cannot be read in the current client, explain that repeating the query may charge again and obtain the user's approval first.
- A page may contain more records than are displayed. State the retrieved and displayed counts, preserve undisplayed paid records when possible, and do not query the same page again merely to show them.
- For time-based media tools, do not submit multiple versions without the user's approval.
- After a disputed charge, preserve the task ID, tool name, timestamps, billable units, and returned error. Do not expose credentials in the diagnostic report.
