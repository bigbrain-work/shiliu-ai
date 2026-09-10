# Web Search

Search the public web and return structured results.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string \| object | yes | The search query. `hybrid` requires an object carrying both `cn` and `global`. |
| `engine` | `cn` \| `global` \| `hybrid` | no | Which engines to search. Defaults to `cn`. |
| `limit` | integer | no | Max web results per engine, 1–10. Defaults to 10, so `hybrid` can return up to `2 × limit`. Non-integers and values outside 1–10 are rejected with `reason: "invalid_limit"`. |

### Engines

| Engine | Sources |
|---|---|
| `cn` | Chinese-mainland search. Chinese and English queries both accepted. |
| `global` | Global search, with no geographic exclusion — mainland Chinese sites can appear here too. Query language shifts ranking and recall rather than filtering. English queries generally produce better results than Chinese queries. |
| `hybrid` | Both engines, queried independently with a separate query each. |

Spacing in Chinese queries is optional. Separate keyword groups with spaces to
control the grouping, or send the phrase unspaced and it is segmented
server-side. Groups you separate yourself are kept as you wrote them.

### `query` and `engine`

| `engine` | Accepted `query` |
|---|---|
| `cn` | A non-empty string. An object is also accepted; its `cn` key must be a non-empty string. |
| `global` | A non-empty string. An object is also accepted; its `global` key must be a non-empty string. |
| `hybrid` | An object with a non-empty `cn` and a non-empty `global`. A bare string is rejected — write each query for the engine that will run it. |

A rejected call occurs before any search, does not include `data`, and returns:

```json
{
  "status": "error",
  "reason": "invalid_query",
  "message": "The selected engine requires a non-empty query."
}
```

For a valid call, `data.queries` reports what was actually sent to each engine.
An invalid query shape returns `reason: "invalid_query"`; an invalid `limit`
returns `reason: "invalid_limit"`.

## Examples

```json
{ "query": "余杭区 购车补贴 2026", "engine": "cn", "limit": 10 }
```

```json
{ "query": "Apple September 2026 event products", "engine": "global", "limit": 10 }
```

```json
{
  "query": {
    "cn": "苹果 2026 秋季发布会 新品",
    "global": "Apple September 2026 event products"
  },
  "engine": "hybrid",
  "limit": 10
}
```

## Response

```json
{
  "status": "success",
  "data": {
    "engine": "hybrid",
    "queries": {
      "cn": "苹果 2026 秋季发布会 新品",
      "global": "Apple September 2026 event products"
    },
    "web": [
      {
        "source": "cn",
        "rank": 1,
        "title": "Result title",
        "url": "https://example.cn/article",
        "description": "Result snippet",
        "published_at": "2026-09-09"
      }
    ],
    "videos": [
      {
        "source": "global",
        "rank": 1,
        "title": "Video title",
        "url": "https://example.com/video",
        "duration": "7:43"
      }
    ],
    "images": [
      {
        "source": "global",
        "rank": 1,
        "title": "Image title",
        "source_page_url": "https://example.com/article",
        "image_url": "https://example.com/image.jpg",
        "thumbnail_url": "https://example.com/thumbnail.jpg"
      }
    ],
    "related_queries": [
      { "source": "global", "query": "苹果 2026 新品 价格" }
    ],
    "people_also_ask": [
      {
        "source": "global",
        "question": "苹果2026秋季发布会什么时候",
        "answer": "Short answer text",
        "url": "https://example.com/answer"
      }
    ],
    "failed": []
  }
}
```

### Fields

- Every entry in every array carries `source: "cn"` or `source: "global"`.
- `rank` is the entry's position within its own engine, starting at 1. It is not a
  cross-engine ranking — a CN `rank: 1` and a Global `rank: 1` both exist.
- With `hybrid`, `web` is merged round-robin by rank: CN 1, Global 1, CN 2,
  Global 2, and so on. When one engine runs short, the other's remaining entries
  follow in order.
- `hybrid` does not deduplicate across engines. The same URL can appear once from
  each source with its respective rank.
- `published_at` is omitted when the source exposes no date. It is never guessed.
- In `people_also_ask`, `answer` and `url` are omitted when the source shows the
  question without an expanded answer.
- `limit` applies to `web` only. `videos`, `images`, `related_queries`, and
  `people_also_ask` are returned when available and do not count toward it.
- Images and videos are metadata and remote URLs. No binary content is returned.
- URL fields are returned as received and may be direct or redirect URLs.
- Arrays are `[]` when empty, never absent.

### Empty results

A search that ran correctly and matched nothing is a success with empty arrays,
not a failure. The query itself is the likely cause: rewrite the keywords —
broader terms, a different language, or the other engine — rather than repeating
the same query.

### Partial and failed results

`failed` reports operational failures only: `upstream_error`, `timeout`, or
`rate_limited`. Under `hybrid` one engine can fail while the other succeeds:

```json
{
  "status": "partial",
  "data": {
    "engine": "hybrid",
    "queries": { "cn": "苹果 2026 秋季发布会 新品", "global": "Apple September 2026 event products" },
    "web": [ { "source": "cn", "rank": 1, "...": "..." } ],
    "videos": [],
    "images": [],
    "related_queries": [],
    "people_also_ask": [],
    "failed": [ { "source": "global", "reason": "upstream_error" } ]
  }
}
```

These failures are unrelated to your query, so an engine listed in `failed` says
nothing about whether matching sources exist. Retrying the unchanged query once is
reasonable. When reporting results, name the scope that dropped out instead of
presenting the surviving engine as full coverage.

When every requested engine fails, the response keeps the per-engine failure
details in `data.failed`:

```json
{
  "status": "error",
  "reason": "all_engines_failed",
  "data": {
    "engine": "hybrid",
    "queries": {
      "cn": "苹果 2026 秋季发布会 新品",
      "global": "Apple September 2026 event products"
    },
    "web": [],
    "videos": [],
    "images": [],
    "related_queries": [],
    "people_also_ask": [],
    "failed": [
      { "source": "cn", "reason": "timeout" },
      { "source": "global", "reason": "upstream_error" }
    ]
  }
}
```

Unlike validation errors, `all_engines_failed` is returned after searches were
attempted and therefore includes `data`.

`status` is `success` when every requested engine completed successfully,
`partial` when some failed, and `error` when all of them failed or the request
was invalid.
