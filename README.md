# Trailmates MCP

A remote [MCP](https://modelcontextprotocol.io) server, running on Cloudflare Workers, for finding local hikes by meaning ("shaded creek walk with a waterfall, under 3 miles"). It exposes three tools: `search_hikes`, `add_hike` and `delete_hike`. Search runs over a shared seed of 18 LA-area trails (Pasadena, Altadena, Griffith Park, Malibu, the Verdugos) plus any private hikes you add yourself. Private hikes are visible only to you, behind GitHub sign-in. Closures are first-class: trails closed by the Eaton Fire are hidden from search by default and shown, with their closed-through date, on request.

Built on Workers AI embeddings, Cloudflare Vectorize (vectors), D1 (records and authorization), and `workers-oauth-provider` for OAuth.

## Try it

The server lives at `https://trailmates-mcp.billzajac.workers.dev` (MCP endpoint `/mcp`, health check `/healthz`). All of `/mcp` requires GitHub sign-in; there is no anonymous access.

```bash
claude mcp add --transport http trailmates https://trailmates-mcp.billzajac.workers.dev/mcp
```

Then authenticate from your client (in Claude Code, run `/mcp`). You will see a consent page for your client, then GitHub.

The hosted instance is for demonstration only. Its GitHub OAuth app is not configured yet, so sign-in does not work there yet. Self-hosting ([Deploy your own](#deploy-your-own)) is the supported path. To see the flow without signing in, read the [demo script](docs/demo.md) (a recording has not been added yet).

Example prompts:

- "What waterfalls are open to hike this weekend?" (Waterfall trails such as Solstice Canyon and Escondido Falls come back with a verify flag, meaning their status is unconfirmed; Eaton Canyon is closed and is not suggested.)
- "Same search, but include closed trails." (Eaton Canyon comes back, closed through 2027-12-31.)
- "Add a private hike: Backyard Loop in Altadena, 1.5 miles, easy, quiet and shaded." Then ask for it by meaning, then delete it.

## How it works

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
 └─ D1                      ── trails (authorization boundary)
```

A `search_hikes` call arrives with an OAuth token. The provider verifies it and hands the tool the signed-in user's GitHub numeric id. The query is embedded with Workers AI, and Vectorize is asked for nearby vectors, filtered to shared trails plus that user's and by any distance, gain and difficulty constraints. Closure rules are not part of the vector filter. The candidate ids are then loaded from D1 (scoped to shared trails and the caller), every constraint is re-applied in code, the closure rules are applied, and the results are returned with their status.

D1 is the source of truth and the authorization boundary. Vectorize is only an index: its owner filter makes queries faster, but a vector id that is stale, injected or foreign still cannot return a row, because D1 will not hand out a private hike to anyone but its owner. Vectorize can be wiped and rebuilt from D1 at any time.

## Why Vectorize instead of pgvector

| | Cloudflare Vectorize | pgvector (Postgres) |
|---|---|---|
| Setup and ops | A Worker binding. No database server to provision, patch or scale. | A Postgres you run or rent, with the extension enabled and connection management. |
| Cost | Included in the Workers free tier at this scale. | A database instance or managed plan, always on. |
| Filtering | Metadata filters only on properties with a metadata index: at most 10 indexes, string values indexed by a 64-byte prefix, filter size capped at 2 KiB. | Any SQL `WHERE`, joins and indexes. |
| Result size | `topK` up to 100 when returning no metadata (lower with it). | `LIMIT` as you like. |
| Consistency | Upserts are asynchronous and eventually consistent: a new vector can take seconds to minutes to be queryable. | Transactional, read-your-writes. |
| Relational data | None. No joins to ownership or status tables. | Vectors sit next to the rest of your data. |

That last row is why this project keeps D1 as the source of truth and the authorization boundary, with Vectorize as a rebuildable index (`/admin/reindex` repopulates it from D1). The tradeoff is real: you give up SQL filtering and immediate consistency, and you gain zero-ops hosting.

The vector store sits behind a small `VectorStore` port (`src/ports.ts`), so the backend is swappable. Moving to pgvector would mean writing a new adapter for that port, replacing Vectorize metadata indexes with SQL `WHERE` clauses and the `<=>` cosine-distance operator, and putting Hyperdrive in front of Postgres for connection pooling from Workers. The tools, closure rules and authorization model would not change.

## Closures

"Today" and the default search date are the `America/Los_Angeles` calendar date. `closed_until` means closed through that date, inclusive. Precedence for the target date:

| status | closed_until | Result |
|---|---|---|
| `closed` | null | Excluded (indefinite closure) |
| `closed` | on or after target date | Excluded; closed-through date shown |
| `closed` | before target date | Shown as **verify** ("closure may have ended"), never as open |
| `verify` | any | Returned with a verify flag |
| `open` | null | Returned; note shows `status_checked` if older than 180 days |
| `open` | on or after target date | Contradictory data: treated as closed and flagged |
| `open` | before target date | Returned (stale closure date ignored) |

`include_closed = true` returns closed trails with `closed_through`. A trail named exactly in the query is always returned with its status. In the seed, both Eaton Canyon entrances and Millard Falls are closed through 2027-12-31 because of the Eaton Fire closures. A search for "Eaton Canyon waterfall hike" therefore returns other trails, not Eaton, unless `include_closed` is set.

## Retrieval quality

Live eval on the deployed Worker, model `@cf/baai/bge-base-en-v1.5`, 11 fixed cases (10 scored plus 1 closure-only negative), evaluated as of 2026-10-07:

| Metric | Result |
|---|---|
| top-1 | 1.0 |
| hit@3 | 1.0 |
| MRR | 1.0 |
| Closure violations | none |

The fixtures in `src/eval/fixtures.ts` are frozen (add cases, do not edit them). Be careful how you read this: with only 18 trails, and fixtures written by the same author as the trail descriptions, it is a regression check and a demonstration of closure-aware negatives, not a benchmark. Per-case results and caveats are in [docs/eval-results.md](docs/eval-results.md).

## Security model

- The owner of every request comes from the verified OAuth token (the GitHub numeric user id), never from tool arguments.
- Every D1 read is scoped to shared trails plus the caller. A foreign id behaves exactly like a nonexistent one. The Vectorize owner filter is a performance filter only.
- Scopes `mcp:read` and `mcp:write` are checked by each tool, because the OAuth provider advertises the required scope but leaves enforcement to the application (per the provider's documentation), so each tool checks its own scope. Search needs read; add and delete need write.
- Each user can hold at most 50 private hikes, enforced atomically inside the insert statement. Descriptions are capped at 2,000 characters.
- Every MCP client registers dynamically, so each client gets its own consent page before the redirect to GitHub. The page sets anti-framing and no-cache headers.
- The GitHub access token is used once, to read the user's id, and is not stored.
- The `/admin/*` routes (seed, reindex, eval) return 404 unless an `ADMIN_TOKEN` secret is set, and require it as a bearer token when it is.

## Deploy your own

Prerequisites: a Cloudflare account, Node 22, and `npm ci`. Order matters; skipping ahead produces an index that silently cannot filter.

**1. Create the Vectorize index and all five metadata indexes before seeding.**

```bash
npx wrangler vectorize create trailmates --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index trailmates --property-name=owner --type=string
npx wrangler vectorize create-metadata-index trailmates --property-name=status --type=string
npx wrangler vectorize create-metadata-index trailmates --property-name=difficulty_rank --type=number
npx wrangler vectorize create-metadata-index trailmates --property-name=distance_max_mi --type=number
npx wrangler vectorize create-metadata-index trailmates --property-name=gain_max_ft --type=number
npx wrangler vectorize list-metadata-index trailmates
```

Metadata indexes are created asynchronously, one at a time. Re-run the `list-metadata-index` command until all five are listed before you seed. Vectors upserted before an index exists are not indexed for filtering.

**2. Create the database and KV namespace.**

```bash
npx wrangler d1 create trailmates
npx wrangler kv namespace create OAUTH_KV
```

**3. Edit `wrangler.jsonc` before anything else touches D1.** The committed `database_id` and KV `id` belong to the maintainer's Cloudflare account and must be replaced: put the `database_id` and the KV `id` printed by the commands above in their place. Set `PUBLIC_BASE_URL` to a placeholder such as `https://trailmates-mcp.example.workers.dev` for now. Then apply the migration, deploy once to learn your workers.dev URL, set `PUBLIC_BASE_URL` to the real URL, and deploy again:

```bash
npx wrangler d1 migrations apply trailmates --remote
npx wrangler deploy
# edit PUBLIC_BASE_URL in wrangler.jsonc to the URL printed above, then:
npx wrangler deploy
export PUBLIC_BASE_URL="https://trailmates-mcp.<your-subdomain>.workers.dev"
curl -s "$PUBLIC_BASE_URL/healthz"   # ok
```

**4. Create a GitHub OAuth app and set the secrets.** At github.com/settings/developers create an OAuth App with Homepage URL `<PUBLIC_BASE_URL>` and Authorization callback URL `<PUBLIC_BASE_URL>/callback`. Each command prompts for its value:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN   # a long random string
read -rs ADMIN_TOKEN && export ADMIN_TOKEN   # paste the same value again
```

**5. Seed the trails.**

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_BASE_URL/admin/seed"
```

**6. Wait for Vectorize, then run the eval.** Vectorize makes new vectors queryable asynchronously; in testing this took anywhere from seconds to about 3 minutes. Poll the eval until it reports `"ready":true` (allow up to about 6 minutes) before trusting any results:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_BASE_URL/admin/eval"
```

**7. If rows were not indexed, reindex.** `/admin/reindex` processes one chunk of 20 rows per call. Call it repeatedly until `remaining` is 0, and stop if `indexed` is 0 (rows that keep failing stay counted in `remaining`, so looping on `remaining` alone never ends). Add `?all=1` only on the first call: it marks every row pending again to re-embed everything.

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_BASE_URL/admin/reindex"
```

The Workers Free plan allows 50 subrequests per invocation, so the code batches embedding, Vectorize and D1 calls and indexes in chunks of 20.

## Development

```bash
npm install
npm test
npm run typecheck
```

Unit tests run with Vitest in the Workers runtime. Workers AI and Vectorize are not emulated locally, so the tests use in-memory fakes behind the `Embedder` and `VectorStore` ports. The live check is `POST /admin/eval` against a deployed Worker. CI runs `npm ci`, typecheck and tests on every push to `main` and on pull requests; it needs no secrets.

## Roadmap

- `plan_outing`: closure check for a date plus a packing and logistics checklist
- `commit_to_hike`: record a commitment with a buddy
- `check_in`: mark a commitment done (accountability buddy)
- Trail coordinates from OpenStreetMap
- More cities
- Per-row reindex fallback

These are not built yet. The server today has the three tools above.

## License

MIT. See [LICENSE](LICENSE).
