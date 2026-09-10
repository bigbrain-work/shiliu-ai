# Workflow patterns

Always resolve the exact live tool name and schema through `tools/list` before applying these patterns.

## Public web search

Read [web-search.md](web-search.md), then call the live `web_search` tool with the scope and query shape described there. Use the structured results as evidence; fetch a result page separately only when the task needs its full contents.

## Single video or author lookup

1. Identify the platform from the URL.
2. Choose the platform-specific single-video or author tool.
3. Validate the URL against the live input schema.
4. Call once and return the requested fields without inventing absent values.

## Author video list with pagination

1. Call the platform-specific author-video-list tool with the author's URL and only supported filters.
2. Return the first page when it satisfies the request.
3. If more results are needed, copy the continuation cursor exactly from the response into the cursor field accepted by the live schema.
4. Stop when the service reports no more data, no cursor is returned, or the user's requested amount is reached.

Never reuse a cursor across authors, platforms, filters, or accounts.

## Video or audio text extraction

1. Submit the source URL once.
2. Save the returned task ID.
3. Poll the matching task-status tool at a reasonable interval.
4. Return completed text and timestamps only when present in the final response.
5. If the task fails, report the service error and do not automatically create a duplicate paid task.

## Media generation or editing

1. Confirm the requested deliverable, source assets, and key constraints.
2. Select the narrowest live generation or editing tool.
3. Explain that the operation can consume points before submitting it.
4. Track the returned task ID until completion.

## Feishu sync tasks

Distinguish creating a task, updating its schedule or authorization, running it now, reading logs, disabling it, transferring ownership, and deleting it. Destructive or ownership-changing actions require explicit user intent.
