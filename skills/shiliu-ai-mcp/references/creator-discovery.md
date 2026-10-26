# Creator (达人 / KOL) discovery

Use this playbook when the user wants to:

- list creator content categories (分区);
- find which first-level category a Douyin account belongs to;
- find creators (达人) in a first-level category;
- fetch those creators' Douyin works, for example to look for viral videos (爆款).

Call the data "达人" or "KOL" data. Do not guess or name where the service sources it.

Confirm the exact names and schemas in the live `tools/list` before calling anything. The names below are current when this was written.

## Tools in this workflow

| Step | Tool | Input | Useful output |
| --- | --- | --- | --- |
| Category dictionary | `get_douyin_author_categories` | none | `data`: `[{id, name, children: [{id, name}]}]`. Top-level items are first-level categories |
| Account identity | `resolve_douyin_author_identity` | exactly one of `author_id`, `sec_uid`, `uid`, `unique_id` | `id` (creator ID), `sec_uid`, `core_user_id`, `unique_id`, `nick_name`, `follower`, `category_id`, `tags_ids` / `tags` (first level), `tags_ids_level_two` / `tags_level_two`, `tags_relation` |
| Creator classification | `get_douyin_author_classification` | `author_id` | category and profile fields. Use only when the identity response lacks category fields |
| Creators by category | `search_douyin_authors_by_category` | `category_id` (first level), `page`, `size` ≤ 20 | `data.authors[].attribute_datas`, `data.pagination` (`has_more`, `total_count`) |
| Works list | `get_douyin_author_videos` | `url` = `https://www.douyin.com/user/{sec_uid}`, `max_cursor` | `videos[]` with `awemeId`, `desc`, `createTime`, `shareUrl`, `tags`, `statistics` (`diggCount`, `collectCount`, `commentCount`, `shareCount`); `has_more`, `max_cursor` |
| Play count (optional) | `get_douyin_video_play_count` | video `url` (use `shareUrl`) | `play_count` |

Data handling rules:

- Apart from the category dictionary, creator data keeps the provider's raw fields. Numbers may be strings, several fields are JSON strings (`last_10_items`, `tags_relation`, `content_theme_labels_180d`), and any field may be missing or `null`. Parse defensively. Treat a missing value as unknown, never as 0.
- The category dictionary rarely changes. Fetch it at most once per task and reuse it.
- Search results include `core_user_id` (the Douyin `uid`) and the creator ID (`attribute_datas.id`), but not `sec_uid`. The works-list tool needs `sec_uid`, so each creator needs one `resolve_douyin_author_identity` call with `uid` = `core_user_id`.
- A category search covers only results visible to the service account and may cap totals and pages. Never present it as all Douyin creators.

## Cost control (mandatory)

Every step above is paid. Before the first paid call in this workflow:

1. Ask how many creators and how many works pages per creator the user wants. Recommend **20 creators, 1 works page each** when the user has no preference, and say the user can change it.
2. Read the current price of each planned tool from its live description or from previous `billing` results. Do not reuse prices from memory.
3. Give the user a plan: steps, number of calls, unit price, and an estimated total. Use this formula:
   - dictionary: 1 call (0 if already in context)
   - search: `ceil(creators / size)` calls
   - identity: 1 call per creator, plus 1 for the seed account
   - works: `creators × pages` calls. This tool charges per returned video, so estimate `videos per page × per-video price` per call. After the first page, use its actual `billing.consumed_credits`.
   - play counts: none unless the user asks for them; then 1 call per video
4. Ask the user to confirm the plan and a point cap. Optionally show the balance from the free `get_account_balance`.
5. Do not start paid calls until the user confirms. The service does not enforce a cap; the Agent must.
6. Add up `billing.consumed_credits` after every call. If the next call could exceed the cap, stop, report the amount spent so far, and ask before continuing.
7. Do not re-query data that is still in context. Do not retry just because a field is empty.

Prefer the cheapest path. Let the user narrow the creators first, then fetch works lists only for the creators they still care about.

## Flow A: list categories

Call `get_douyin_author_categories` and show the first-level `id: name` pairs. Show `children` only when the user asks for second-level categories. Keep the dictionary for later steps.

## Flow B: account → first-level category

1. Turn the input into one identity field:
   - homepage URL `https://www.douyin.com/user/MS4...` → `sec_uid`
   - numeric Douyin UID → `uid`
   - Douyin ID (抖音号) → `unique_id`
   - creator ID → `author_id`
   - share or short link → resolve it with the Douyin author tool first (paid), then use the returned `secUid`
2. Call `resolve_douyin_author_identity` once.
3. If it matches, report the first-level category from `category_id` / `tags_ids` / `tags` and the second level from `tags_relation`. Use the dictionary to map IDs to names only when names are absent.
4. If it does not match (empty data, no creator ID, or an explicit not-matched result):
   - tell the user no creator identity was found for this account, and that this does not prove the account does not exist;
   - ask whether they want the category inferred from the account's existing works;
   - if yes, estimate the cost of one works page and get confirmation. Then compare the works' `desc`, hashtags and `tags` with the first-level dictionary names. Report the result as **inferred**, with evidence and confidence.
   - do not search a category until the user confirms which one.

If the user specifies a category name instead, match it to a first-level ID from the dictionary. Ask when the name is ambiguous.

## Flow C: category → creators

1. Call `search_douyin_authors_by_category` with the first-level `category_id`, starting at `page` 1. Choose `size` so you do not fetch more creators than requested.
2. Show each creator: nickname (`nick_name`), creator ID (`id`), Douyin UID (`core_user_id`), followers (`follower`), and category (`tags_relation`).
3. Page only while `pagination.has_more` is true and the requested count is not reached. Report `total_count` as the service's visible count, not a market total.

## Flow D: creators → Douyin works

1. For each creator kept, call `resolve_douyin_author_identity` with `uid` = `core_user_id` to get `sec_uid`.
2. Call `get_douyin_author_videos` with `https://www.douyin.com/user/{sec_uid}`. For more pages, pass `max_cursor` exactly as returned, up to the confirmed page count. Never reuse a cursor across creators.
3. Return the works with title (`desc`), publish date, `shareUrl`, likes, collects, comments and shares. State the counts retrieved versus displayed, and the total points spent against the confirmed cap.

## Analyzing works (for example, viral videos)

The user and the Agent choose the analysis method. Facts to account for:

- The works list has likes, collects, comments and shares, but **no play count**.
- Play counts need one paid `get_douyin_video_play_count` call per video. They can also be inflated by paid promotion, so they may not reflect content quality. Do not fetch them unless the user asks, and estimate the cost first.
- `attribute_datas.last_10_items` in search results already has `vv` (plays), `like_cnt`, `comment_cnt` and `share_cnt` for each creator's latest 10 works, at no extra cost. It has no collect count.
- One possible signal is the collect/like ratio (收藏 ÷ 点赞), which reflects how often viewers save a video for later.
- Very small counts give unstable ratios. Treat missing values as unknown.
