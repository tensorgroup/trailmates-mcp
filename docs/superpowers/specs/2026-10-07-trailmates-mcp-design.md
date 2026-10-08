# Trailmates MCP: Design

Date: 2026-10-07 · Status: revised after design review, approved for planning · Repo: github.com/tensorgroup/trailmates-mcp (private until ready)

## Purpose

A small open-source remote MCP server for finding local hikes by meaning ("shaded creek walk with a
waterfall, under 3 miles") and planning outings with friends. Built in a weekend to put shipped MCP
and vector-database work on the author's record (prep for a Caltech Enterprise AI role). The author
uses it for real: LA-area hikes (Pasadena, Altadena, Griffith, Malibu, Verdugos).

## Decisions made

| Decision | Choice | Why |
|---|---|---|
| Project | Trailmates (hikes + outing planning + buddy commitments) | Real data and a real use |
| Hosting | Cloudflare Workers | Free tier, one-command deploy |
| Vector store | Cloudflare Vectorize (not pgvector) | Free, a Worker binding, no DB server to run. README explains the tradeoff vs pgvector |
| Records | D1 (SQLite) | Source of truth *and* security boundary; Vectorize is a rebuildable index |
| Embeddings | Workers AI `bge-base-en-v1.5` (768-dim, cosine, `pooling: "cls"`) | No external API key |
| MCP server | `createMcpHandler` from `agents/mcp/server` (stateless), `@modelcontextprotocol/server` | `McpAgent` is deprecated and feature-frozen (Cloudflare docs); we need no protocol-session state. Pin Agents, MCP SDK, and OAuth-provider versions together; `nodejs_compat` on |
| Language | TypeScript | Cloudflare MCP tooling is TypeScript-first |
| Data ownership | Shared seed + per-user private hikes | Real MCP auth, no moderation burden |
| Auth | GitHub OAuth via `workers-oauth-provider` | Free, no user DB, stable user ID, developer audience |
| Repo | `tensorgroup/trailmates-mcp`, MIT license | Open source |

## Architecture

```
MCP client (Claude, etc.)
   │  Streamable HTTP + OAuth (dynamic client registration)
   ▼
Cloudflare Worker (TypeScript)
 ├─ workers-oauth-provider ── token issue; KV namespace OAUTH_KV for grants/clients
 │    └─ /authorize: consent page per client → GitHub → callback
 ├─ createMcpHandler        ── tools (stateless, no Durable Objects)
 ├─ Workers AI              ── embeddings
 ├─ Vectorize               ── vectors + filter metadata (performance filter only)
 └─ D1                      ── trails, commitments (authorization boundary)
```

### Auth flow requirements (from MCP security best practices / provider docs)

- MCP clients register dynamically, so every client gets a **per-client consent screen** before the
  redirect to GitHub (confused-deputy protection). The consent page needs a signed binding cookie,
  no framing, no caching. This is a small HTML page, the one exception to "no web UI". The page always
  grants `mcp:read` and offers `mcp:write` as a checked option; the server, not the client, decides
  what can be offered. Tools check scopes themselves because the provider does not enforce them.
- Validate the GitHub callback `state` against the browser binding before exchanging the code.
- MCP tokens carry the verified GitHub **numeric user id** (not `login`, which can be renamed and
  reused) in their props.
- Set the canonical `resourceMetadata.resource`; confirm the provider version serves protected
  resource metadata and accepts resource indicators.
- **Decision:** all of `/mcp` requires sign-in (no anonymous reads). The README shows a recorded demo
  so visitors can see the shared seed without signing in.

## Data model

- **D1 `trails`**: `id`, name, area, trailhead, route_type, `distance_min_mi`, `distance_max_mi`,
  `gain_min_ft` / `gain_max_ft` (nullable), `difficulty` (enum `easy | moderate | hard`; the seed's
  "easy to moderate" maps to its harder bound, stored with the original text in `difficulty_note`),
  tags (JSON), description, `owner`, `status` (`open | closed | verify`), `closed_until`,
  `status_note`, `status_checked`, `source_urls` (JSON), `index_state` (`pending | indexed | failed`),
  `indexed_at`.
- **IDs:** seed trails keep readable ids prefixed `seed:` (e.g. `seed:runyon-canyon-loop`); private
  hikes get ids derived as `u:` + first 32 hex chars of SHA-256(owner + name + trailhead), so a retried
  `add_hike` is idempotent (same hike, same id) and two users can never collide because the owner is in
  the hash. Ids stay within 64 bytes, the Vectorize id limit. Re-adding the same name and trailhead
  updates the existing hike.
- **`owner`** is `"shared"` or the GitHub numeric user id.
- **D1 `commitments`**: id (UUID), owner, trail_id, date, buddy (free text), note, checked_in_at.
- **Vectorize**: one vector per trail. Embedded text = name + area + difficulty + distance + tags +
  description. Metadata indexes (created **before** any vectors are inserted; vectors added earlier
  must be re-upserted): `owner`, `status`, `difficulty_rank`, `distance_max_mi`, `gain_max_ft`.
- D1 is authoritative. A `reindex` script rebuilds Vectorize from D1 (it also repairs `failed` and
  `pending` rows).
- Seed: `data/trails.seed.json` loaded with `owner = "shared"`. Author-specific fields (`favorite`)
  are dropped on load. Every record gets real `source_urls` before the dataset is published.

## Tools

All tools derive `owner` from the OAuth token, never from arguments. **Every D1 read or write is
scoped:** trails by `owner IN ('shared', :me)`, commitments by `owner = :me`. A foreign `trail_id` or
`commitment_id` behaves exactly like a nonexistent one. Vectorize's owner filter is only a
performance filter; D1 hydration re-checks ownership so an injected or stale vector result can
never leak a private hike.

| Tool | Behavior |
|---|---|
| `search_hikes(query, max_distance?, max_gain?, difficulty?, include_closed?, date?)` | Embed query; query Vectorize with a filter (`owner IN (shared, me)`, closure and numeric constraints), overfetching (`topK` up to 100, `returnMetadata: "none"`) so post-filtering cannot empty a page; hydrate from D1; re-apply every constraint in code; return matches with status. A direct name match is looked up in D1 (owner-scoped) so just-added or closed trails are still found by name |
| `add_hike(...)` | Insert a private hike (D1 first, `index_state = pending`), then embed and upsert. On failure the row stays `pending/failed` and the tool replies "saved; indexing pending". Retries are idempotent (stable id). Per-user cap (50 hikes) and description length cap (2,000 chars) |
| `delete_hike(trail_id)` | Delete the caller's own hike from D1 and Vectorize (`deleteByIds`). Shared trails cannot be deleted by users |
| `plan_outing(trail_id, date, group_size?)` | Closure check for that date, hike facts, packing/logistics checklist. No LLM call inside the server |
| `commit_to_hike(trail_id, date, buddy, note?)` | Record a commitment (warn if the date falls in a closure), return upcoming ones |
| `check_in(commitment_id, note?)` | Mark a commitment done |

All read-only tools set `readOnlyHint`; `delete_hike` sets `destructiveHint`.

### Filter semantics

- `max_distance` / `max_gain` match on the **upper bound**: a trail passes only if its max is within
  the limit (Runyon at 2.8–3.5 mi does not match `max_distance = 3`). Results display the full range.
- Unknown values (null gain) are excluded when a gain limit is set and flagged "gain unknown" otherwise.
- `difficulty` matches the normalized enum; a range like "easy to moderate" is stored as `moderate`
  with the original text kept.

## Closure rules

"Today" and the default `date` are the `America/Los_Angeles` calendar date (Workers run in UTC).
`closed_until` means "closed through this date, inclusive". Precedence, evaluated for the target date:

| status | closed_until | Result |
|---|---|---|
| `closed` | null | Excluded (indefinite closure) |
| `closed` | ≥ target date | Excluded; closed-through date shown |
| `closed` | < target date | Shown as **verify** ("closure may have ended"), never as open |
| `verify` | any | Returned with a verify flag |
| `open` | null | Returned; note shows `status_checked` if older than 180 days |
| `open` | ≥ target date | Contradictory data: treated as closed and flagged in the response |
| `open` | < target date | Returned (stale closure date ignored) |

- `include_closed = true` returns closed trails with their closed-through date (`closed_through`, the last closed day, inclusive).
- `status_note` is stored and surfaced (e.g. Eaton: "through at least", "verify with ANF").
- Seed examples: both Eaton Canyon entrances closed until 2027-12-31 (LA County notice).

## Security and errors

- Private hikes are visible only to their owner; the shared seed is read-only to users.
- Inputs validated with zod; failures return clear tool errors.
- Write order is D1 first, then Vectorize; search drops vector ids missing from D1. Vectorize
  upserts are asynchronous, so a new hike may take seconds to appear in search; a *failed* upsert is
  different (row stays `failed`, repaired by `reindex`).
- No secrets in the repo; GitHub client ID/secret via Wrangler secrets. Provisioning: D1, Vectorize
  index and metadata indexes, `OAUTH_KV`, Workers AI binding, all in the deploy guide.
- Free-plan limits: Workers Free allows 50 subrequests per invocation, so embeddings, Vectorize
  upserts and D1 writes are batched and indexing runs in chunks of 20 rows per request.
- Abuse limits: per-user hike and commitment caps, description length cap (dynamic client
  registration plus any GitHub account means untrusted users spend the owner's free-tier quotas).

## Testing

- **Unit tests** with `@cloudflare/vitest-plugin`: closure truth table (every row), filter semantics,
  owner scoping on **every** tool using foreign ids, validation. The vector store and embedder sit
  behind small interfaces with in-memory fakes, because Workers AI and Vectorize are not emulated
  locally.
- **Isolation test:** user A adds a hike; user B gets "not found" from search, plan, commit, check-in
  and delete, including with an injected foreign vector result.
- **Indexing failure test:** failed upsert leaves `failed`, then `reindex` repairs it, no duplicates.
- **Real-service smoke and eval** (manual, against the deployed Worker, not in CI): seeds the index,
  polls until the eval reports `ready: true` (an empty or not-yet-visible index cannot pass), then
  records the frozen eval.
- **Retrieval eval:** 10+ frozen fixtures (query, dates, relevant ids) scored by top-1, hit@3 and MRR,
  including closure-aware negatives (a waterfall query must not surface Eaton). Results committed.
- GitHub Actions runs unit tests on push (no secrets needed, so fork PRs work).

## Milestones

1. **Core:** scaffold, seed loader, embeddings, `search_hikes`, `add_hike`, `delete_hike`, closure
   rules, GitHub auth with consent page, deploy, an MCP client connection walkthrough.
2. **Polish:** README with diagram and pgvector tradeoff, deploy guide, eval results, demo, make repo public.
3. **Follow-up (after the weekend ship; review-recommended cut):** `plan_outing`, `commit_to_hike`,
   `check_in`, and the `commitments` table. The tools table above specifies them so the design stays
   whole, but they are not built or tested in the weekend scope.

Weekend scope is milestones 1 and 2 only: auth, ownership tests, indexing repair, closure
correctness, the retrieval eval, and a demonstrated client workflow.

## Non-goals

Maps/GPS tracks, photos, buddy accounts or matching (a possible follow-up project),
open community submissions, moderation, a web UI beyond the OAuth consent page, anonymous access.

## Open items

- Seed data: name the back-side road for the Griffith helipad loop; Millard Falls status; coordinates
  (OSM); rewrite descriptions in the author's voice; attach real `source_urls`.
- Confirm current free-tier limits and the exact pinned versions of Agents, MCP SDK v2, and
  `workers-oauth-provider` when writing the plan.
