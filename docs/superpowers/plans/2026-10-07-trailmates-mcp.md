# Trailmates MCP Implementation Plan

**Goal:** Ship a remote MCP server on Cloudflare Workers that finds hikes by meaning (Vectorize + Workers AI), keeps per-user private hikes behind GitHub sign-in, and respects trail closures with dates.

**Architecture:** A single Worker. `workers-oauth-provider` handles OAuth (consent page, GitHub sign-in, token issue) and forwards `/mcp` to a stateless `createMcpHandler` server. D1 is the source of truth and the authorization boundary; Vectorize is a rebuildable index and a performance filter only. Embeddings come from Workers AI. Pure domain logic (closure rules, filters, seed normalization) is separated from adapters so it is unit-tested with in-memory fakes.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vectorize, Workers AI (`@cf/baai/bge-base-en-v1.5`), `agents` (`createMcpHandler`), `@modelcontextprotocol/server` v2, `@cloudflare/workers-oauth-provider` v1, zod 4, Vitest 4 with `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-10-07-trailmates-mcp-design.md` (read it first; this plan implements milestones 1 and 2 of it. `plan_outing`, `commit_to_hike`, `check_in` and the `commitments` table are the follow-up milestone and are NOT built here).

## Global Constraints

- Language/runtime: TypeScript with `"strict": true`; Node 22 for tooling; Worker `compatibility_date` `2026-09-01`, flag `nodejs_compat`.
- Pinned versions: `agents@0.27.0`, `@cloudflare/workers-oauth-provider@1.2.3`, `zod@4.6.5`, `wrangler@4.148.0`, `@cloudflare/vitest-plugin@1.3.7`, `vitest@^4.1.0`. `@modelcontextprotocol/server` must be the exact version `agents@0.27.0` requires (docs show `2.0.0`; Task 1 verifies).
- Embeddings: model `@cf/baai/bge-base-en-v1.5`, `pooling: "cls"`, 768 dimensions, cosine metric.
- Vectorize limits: `topK` max 100 with `returnMetadata: "none"` (50 if values or full metadata); filter JSON < 2048 bytes; max 10 metadata indexes; indexed strings use first 64 bytes; vector ids ≤ 64 bytes; metadata indexes MUST exist before vectors are upserted (earlier vectors must be re-upserted).
- Workers Free allows 50 subrequests per invocation, and D1 queries count against it: batch embeddings (`embedMany`), Vectorize upserts, and D1 writes (`db.batch`), and index in chunks of 20 rows per request (`REINDEX_CHUNK`).
- D1: max 100 bound parameters per query (chunk id lists at 90); `exec()` runs one statement per line, so use `prepare().run()` for multi-line SQL.
- Scopes: `mcp:read` (search) and `mcp:write` (add/delete). The OAuth provider advertises scopes but does not enforce them, so every tool checks the scope itself.
- Security: `owner` always comes from the OAuth token props (`userId` = GitHub **numeric** id as a string), never from tool arguments. Every D1 read/write is scoped to `owner IN ('shared', :me)` (reads) or `owner = :me` (writes). Never log or return tokens, `authInfo.token`, or `authInfo.extra.props`.
- Dates: ISO `YYYY-MM-DD`; "today" is the `America/Los_Angeles` calendar date; `closed_until` is inclusive.
- Limits: 50 private hikes per user; description ≤ 2,000 chars; search `limit` ≤ 25; query ≤ 500 chars.
- Do not run `git commit` or `git push` unless the repository owner has asked. Each task ends with a **Checkpoint** step (run the checks, review `git status`) instead of a commit.
- Do not add files outside this plan's file map except where a step says so.

## Review Focus

Inputs and conditions the spec implies but the happy-path tests would miss. Each has an owning task with a test.

1. Whitespace-only, empty, or oversize `query`; `max_distance` of 0, negative, or NaN → clear validation error, never a 500 or a silent empty result (Task 9).
2. `delete_hike` with a seed id, another user's id, or a nonexistent id → "not found", nothing deleted (Task 8).
3. Hike names/descriptions with HTML, emoji, and exactly 2,000 characters; 2,001 rejected (Task 8).
4. Vectorize returns ids that are missing from D1 (stale) or belong to another user (injected) → dropped silently, no leak, no crash (Task 7).
5. Impossible or malformed `date` (`2026-02-30`, `10/07/2026`) → validation error; closure boundary day (`closed_until == date`) is still closed (Tasks 2 and 9).
6. More than 90 candidate ids in one search (D1's 100-parameter limit) → still works (Task 5).
7. `add_hike` where embedding or upsert throws → hike saved as `failed`, tool says indexing pending, a retry does not duplicate, `reindex` repairs it (Task 8).

8. A user who unticks write permission, a token with no read scope, and a user who declines at GitHub or tampers with the consent handle → clear refusal or standard OAuth error, never a 500 and never a silent write (Tasks 9 and 11).
9. Two `add_hike` calls racing at 49 hikes, and a seed or reindex larger than one request can embed → the cap holds and indexing resumes in chunks (Tasks 5 and 8).

## File Map

```
package.json  package-lock.json  tsconfig.json  wrangler.jsonc  wrangler.test.jsonc  vitest.config.ts
.gitignore  .dev.vars.example  LICENSE  README.md  .github/workflows/ci.yml
migrations/0001_init.sql
data/trails.seed.json                      (exists; Task 4 adds source_urls)
src/env.ts                                 Env bindings type
src/domain/types.ts                        Trail and enums
src/domain/closure.ts                      laToday, evaluateClosure
src/domain/search-rules.ts                 checkConstraints, buildVectorFilter, toVectorMetadata, embeddingText
src/domain/seed.ts                         zod seed schema + normalizeSeed
src/ports.ts                               Embedder, VectorStore interfaces
src/adapters/workers-ai.ts                 WorkersAiEmbedder
src/adapters/vectorize.ts                  VectorizeStore
src/db/trails-repo.ts                      owner-scoped D1 access
src/services/deps.ts                       Deps type
src/services/search.ts                     searchHikes
src/services/hikes.ts                      addHike, deleteHike, UserError, addHikeSchema
src/services/indexing.ts                   reindexTrails, seedShared
src/eval/fixtures.ts  src/eval/run.ts      retrieval eval (docs/eval-results.md holds recorded results)
src/mcp/tools.ts                           tool schemas + handlers + callTool
src/mcp/server.ts                          McpServer registration
src/auth/github.ts                         PKCE, GitHub URL/exchange/user
src/auth/consent-page.ts                   HTML consent page
src/auth/handler.ts                        defaultHandler routes (/authorize, /callback, /admin/*, /healthz)
src/admin.ts                               bearer-guarded admin actions
src/deps.ts                                makeDeps(env)
src/index.ts                               Worker entry (OAuthProvider)
test/helpers/{fakes,fixtures,db}.ts  test/cloudflare-test.d.ts
test/*.test.ts                             one per source file
```

---

### Task 1: Scaffold and toolchain smoke test

**Files:**
- Create: `package.json`, `package-lock.json` (generated by `npm install`), `tsconfig.json`, `wrangler.jsonc`, `wrangler.test.jsonc`, `vitest.config.ts`, `.gitignore`, `.dev.vars.example`, `LICENSE`, `src/env.ts`, `test/cloudflare-test.d.ts`, `test/helpers/db.ts`, `migrations/0001_init.sql`, `test/smoke.test.ts`

**Interfaces:**
- Produces: `Env` (in `src/env.ts`); `applySchema(db: D1Database): Promise<void>` and `clearTrails(db): Promise<void>` (in `test/helpers/db.ts`); the `trails` table.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "trailmates-mcp",
  "version": "0.1.0",
  "description": "Remote MCP server for finding hikes by meaning, on Cloudflare Workers + Vectorize + D1",
  "type": "module",
  "license": "MIT",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cloudflare/workers-oauth-provider": "1.2.3",
    "@modelcontextprotocol/server": "2.0.0",
    "agents": "0.27.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.3.7",
    "@cloudflare/workers-types": "5.20261007.1",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0",
    "wrangler": "4.148.0"
  }
}
```

- [ ] **Step 2: Install and verify every pin**

Run:
```bash
npm install
npm view agents@0.27.0 peerDependencies dependencies --json | head -30
for p in "@cloudflare/workers-oauth-provider@1.2.3" "@cloudflare/vitest-plugin@1.3.7" "@cloudflare/workers-types@5.20261007.1" "wrangler@4.148.0" "zod@4.6.5"; do npm view "$p" version; done
npm ls @modelcontextprotocol/server
```
Expected: install succeeds and each `npm view` prints its version. If `agents` names a different `@modelcontextprotocol/server` version than `2.0.0`, set that exact version in `package.json` and rerun `npm install`. If `agents` depends on the older `@modelcontextprotocol/sdk` package instead, stop: Task 9's imports and `registerTool` shape would change, so tell the owner before continuing. The install creates `package-lock.json`; keep it (CI uses `npm ci`).

- [ ] **Step 3: Create config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`wrangler.jsonc` (deploy config; ids are filled in during Task 12):
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "trailmates-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" },
  "d1_databases": [
    { "binding": "DB", "database_name": "trailmates", "database_id": "FILL_IN_TASK_12", "migrations_dir": "migrations" }
  ],
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "trailmates" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "FILL_IN_TASK_12" }],
  "vars": { "PUBLIC_BASE_URL": "https://trailmates-mcp.FILL_IN_TASK_12.workers.dev" }
}
```

`wrangler.test.jsonc` (tests only use D1 and KV; Workers AI and Vectorize are faked because they cannot run locally):
```jsonc
{
  "name": "trailmates-mcp-test",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{ "binding": "DB", "database_name": "trailmates-test", "database_id": "test" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "test" }]
}
```

`vitest.config.ts`:
```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
```

`.gitignore`:
```
node_modules/
.wrangler/
.dev.vars
dist/
worker-configuration.d.ts
```

`.dev.vars.example`:
```
GITHUB_CLIENT_ID=your-github-oauth-app-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-app-client-secret
ADMIN_TOKEN=a-long-random-string
```

`LICENSE`: the standard MIT license text, `Copyright (c) 2026 tensorgroup contributors`.

- [ ] **Step 4: Create `src/env.ts`**

```ts
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE: Vectorize;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_BASE_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ADMIN_TOKEN?: string;
}
```

- [ ] **Step 5: Create the schema `migrations/0001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS trails (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  area TEXT NOT NULL,
  trailhead TEXT NOT NULL,
  route_type TEXT NOT NULL,
  distance_min_mi REAL NOT NULL,
  distance_max_mi REAL NOT NULL,
  gain_min_ft INTEGER,
  gain_max_ft INTEGER,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','moderate','hard')),
  difficulty_note TEXT,
  tags TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed','verify')),
  closed_until TEXT,
  status_note TEXT,
  status_checked TEXT NOT NULL,
  source_urls TEXT NOT NULL,
  index_state TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending','indexed','failed')),
  indexed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trails_owner ON trails(owner);
CREATE INDEX IF NOT EXISTS idx_trails_owner_name ON trails(owner, name COLLATE NOCASE);
```

- [ ] **Step 6: Create test helpers**

`test/cloudflare-test.d.ts`:
```ts
declare module "cloudflare:test" {
  export const env: Record<string, unknown>;
}
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
```

`test/helpers/db.ts`:
```ts
import schemaSql from "../../migrations/0001_init.sql?raw";

export async function applySchema(db: D1Database): Promise<void> {
  const statements = schemaSql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}

export async function clearTrails(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM trails").run();
}
```

- [ ] **Step 7: Write the smoke test `test/smoke.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applySchema } from "./helpers/db";

describe("toolchain smoke", () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  beforeAll(async () => applySchema(db));

  it("runs inside the Workers runtime with a D1 binding and the schema applied", async () => {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM trails").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
```

- [ ] **Step 8: Run it**

Run: `npx vitest run test/smoke.test.ts`
Expected: PASS. If `cloudflare:test` fails to resolve, check the plugin docs ("Define types" in https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/) and use the import path they show (e.g. `cloudflare:workers`), updating `test/cloudflare-test.d.ts` and every later test to match.

- [ ] **Step 9: Checkpoint**

Run: `npm run typecheck && npm test` → both pass. `git status` shows only the scaffold files.

---

### Task 2: Domain types and closure rules

**Files:**
- Create: `src/domain/types.ts`, `src/domain/closure.ts`
- Test: `test/closure.test.ts`

**Interfaces:**
- Produces:
  - `type Status = "open" | "closed" | "verify"`, `type Difficulty = "easy" | "moderate" | "hard"`, `type IndexState = "pending" | "indexed" | "failed"`
  - `DIFFICULTY_RANK: Record<Difficulty, number>` (easy 1, moderate 2, hard 3), `SHARED_OWNER = "shared"`
  - `interface Trail` (fields below)
  - `laToday(now?: Date): string`
  - `evaluateClosure(t: Pick<Trail, "status" | "closedUntil" | "statusChecked">, date: string): ClosureResult` where `ClosureResult = { availability: "available" | "excluded" | "verify"; closedThrough: string | null; flags: string[] }`

- [ ] **Step 1: Create `src/domain/types.ts`**

```ts
export type Status = "open" | "closed" | "verify";
export type Difficulty = "easy" | "moderate" | "hard";
export type IndexState = "pending" | "indexed" | "failed";

export const SHARED_OWNER = "shared";
export const DIFFICULTY_RANK: Record<Difficulty, number> = { easy: 1, moderate: 2, hard: 3 };

export interface Trail {
  id: string;
  owner: string; // "shared" or GitHub numeric user id
  name: string;
  area: string;
  trailhead: string;
  routeType: string;
  distanceMinMi: number;
  distanceMaxMi: number;
  gainMinFt: number | null;
  gainMaxFt: number | null;
  difficulty: Difficulty;
  difficultyNote: string | null;
  tags: string[];
  description: string;
  status: Status;
  closedUntil: string | null; // ISO date, inclusive
  statusNote: string | null;
  statusChecked: string; // ISO date
  sourceUrls: string[];
  indexState: IndexState;
  indexedAt: string | null;
}
```

- [ ] **Step 2: Write the failing tests `test/closure.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { evaluateClosure, laToday } from "../src/domain/closure";

const open = { status: "open" as const, closedUntil: null, statusChecked: "2026-10-01" };

describe("laToday", () => {
  it("uses the Los Angeles calendar date, not UTC", () => {
    expect(laToday(new Date("2026-10-08T03:00:00Z"))).toBe("2026-10-07"); // 8pm PDT on the 7th
    expect(laToday(new Date("2026-10-08T08:00:00Z"))).toBe("2026-10-08");
  });
});

describe("evaluateClosure truth table", () => {
  it("closed with no date is excluded as an indefinite closure", () => {
    const r = evaluateClosure({ ...open, status: "closed" }, "2026-10-07");
    expect(r).toMatchObject({ availability: "excluded", closedThrough: null });
  });
  it("closed through a future date is excluded and reports the reopening date", () => {
    const r = evaluateClosure({ ...open, status: "closed", closedUntil: "2027-12-31" }, "2026-10-07");
    expect(r).toMatchObject({ availability: "excluded", closedThrough: "2027-12-31" });
  });
  it("closed_until is inclusive: the boundary day is still closed", () => {
    const r = evaluateClosure({ ...open, status: "closed", closedUntil: "2027-12-31" }, "2027-12-31");
    expect(r.availability).toBe("excluded");
  });
  it("the day after closed_until is verify, never open", () => {
    const r = evaluateClosure({ ...open, status: "closed", closedUntil: "2027-12-31" }, "2028-01-01");
    expect(r.availability).toBe("verify");
    expect(r.flags.join(" ")).toMatch(/may have ended/);
  });
  it("verify status is returned with a flag", () => {
    const r = evaluateClosure({ ...open, status: "verify" }, "2026-10-07");
    expect(r.availability).toBe("verify");
    expect(r.flags.length).toBeGreaterThan(0);
  });
  it("open with a future closed_until is contradictory and treated as closed", () => {
    const r = evaluateClosure({ ...open, closedUntil: "2026-12-01" }, "2026-10-07");
    expect(r).toMatchObject({ availability: "excluded", closedThrough: "2026-12-01" });
    expect(r.flags.join(" ")).toMatch(/conflicting/);
  });
  it("open with a stale past closed_until is available", () => {
    const r = evaluateClosure({ ...open, closedUntil: "2026-01-01" }, "2026-10-07");
    expect(r.availability).toBe("available");
  });
  it("open is available, and flags a status older than 180 days", () => {
    expect(evaluateClosure(open, "2026-10-07")).toEqual({ availability: "available", closedThrough: null, flags: [] });
    const stale = evaluateClosure({ ...open, statusChecked: "2026-01-01" }, "2026-10-07");
    expect(stale.availability).toBe("available");
    expect(stale.flags.join(" ")).toMatch(/last checked 2026-01-01/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/closure.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/domain/closure.ts`**

```ts
import type { Trail } from "./types";

export interface ClosureResult {
  availability: "available" | "excluded" | "verify";
  closedThrough: string | null;
  flags: string[];
}

const STALE_DAYS = 180;

export function laToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function evaluateClosure(
  t: Pick<Trail, "status" | "closedUntil" | "statusChecked">,
  date: string,
): ClosureResult {
  const until = t.closedUntil;
  if (t.status === "closed") {
    if (until === null) return { availability: "excluded", closedThrough: null, flags: ["closed indefinitely"] };
    if (until >= date) return { availability: "excluded", closedThrough: until, flags: [`closed through ${until}`] };
    return {
      availability: "verify",
      closedThrough: null,
      flags: [`closure listed through ${until} may have ended; verify before going`],
    };
  }
  if (t.status === "verify") {
    return { availability: "verify", closedThrough: null, flags: ["status unverified; check the land manager before going"] };
  }
  if (until !== null && until >= date) {
    return {
      availability: "excluded",
      closedThrough: until,
      flags: [`conflicting data: marked open but closed through ${until}`],
    };
  }
  const flags: string[] = [];
  if (daysBetween(t.statusChecked, date) > STALE_DAYS) flags.push(`status last checked ${t.statusChecked}`);
  return { availability: "available", closedThrough: null, flags };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/closure.test.ts` → all PASS.

- [ ] **Step 6: Checkpoint**

Run: `npm run typecheck && npm test` → pass; review `git status`.

---

### Task 3: Search rules (constraints, vector filter, metadata, embedding text)

**Files:**
- Create: `src/domain/search-rules.ts`
- Test: `test/search-rules.test.ts`

**Interfaces:**
- Consumes: `Trail`, `Difficulty`, `DIFFICULTY_RANK`, `SHARED_OWNER` from `src/domain/types.ts`.
- Produces:
  - `interface SearchConstraints { maxDistanceMi?: number; maxGainFt?: number; difficulty?: Difficulty }`
  - `checkConstraints(t: Pick<Trail, "distanceMaxMi" | "gainMaxFt" | "difficulty">, c: SearchConstraints): { ok: boolean; flags: string[] }`
  - `buildVectorFilter(userId: string, c: SearchConstraints): Record<string, unknown>`
  - `interface VectorMetadata { owner: string; status: string; difficulty_rank: number; distance_max_mi: number; gain_max_ft?: number }`
  - `toVectorMetadata(t: Trail): VectorMetadata`
  - `embeddingText(t: Trail): string`

- [ ] **Step 1: Write the failing tests `test/search-rules.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildVectorFilter, checkConstraints, embeddingText, toVectorMetadata } from "../src/domain/search-rules";
import { makeTrail } from "./helpers/fixtures";

describe("checkConstraints", () => {
  it("matches distance on the upper bound: Runyon 2.8-3.5 mi does not pass max_distance 3", () => {
    const runyon = makeTrail({ distanceMinMi: 2.8, distanceMaxMi: 3.5 });
    expect(checkConstraints(runyon, { maxDistanceMi: 3 }).ok).toBe(false);
    expect(checkConstraints(runyon, { maxDistanceMi: 3.5 }).ok).toBe(true);
  });
  it("excludes unknown gain when a gain limit is set, flags it otherwise", () => {
    const unknown = makeTrail({ gainMinFt: null, gainMaxFt: null });
    expect(checkConstraints(unknown, { maxGainFt: 5000 }).ok).toBe(false);
    expect(checkConstraints(unknown, {})).toEqual({ ok: true, flags: ["gain unknown"] });
  });
  it("matches the normalized difficulty exactly", () => {
    expect(checkConstraints(makeTrail({ difficulty: "moderate" }), { difficulty: "easy" }).ok).toBe(false);
    expect(checkConstraints(makeTrail({ difficulty: "moderate" }), { difficulty: "moderate" }).ok).toBe(true);
  });
});

describe("buildVectorFilter", () => {
  it("always scopes to shared plus the caller", () => {
    expect(buildVectorFilter("42", {})).toEqual({ owner: { $in: ["shared", "42"] } });
  });
  it("adds numeric and difficulty filters and stays under 2048 bytes", () => {
    const f = buildVectorFilter("42", { maxDistanceMi: 3, maxGainFt: 500, difficulty: "hard" });
    expect(f).toEqual({
      owner: { $in: ["shared", "42"] },
      distance_max_mi: { $lte: 3 },
      gain_max_ft: { $lte: 500 },
      difficulty_rank: { $eq: 3 },
    });
    expect(JSON.stringify(f).length).toBeLessThan(2048);
  });
});

describe("toVectorMetadata / embeddingText", () => {
  it("omits gain_max_ft when gain is unknown", () => {
    const m = toVectorMetadata(makeTrail({ gainMaxFt: null }));
    expect("gain_max_ft" in m).toBe(false);
    expect(m).toMatchObject({ owner: "shared", status: "open", difficulty_rank: 2 });
  });
  it("embeds name, area, difficulty, distance, tags and description", () => {
    const text = embeddingText(makeTrail({ name: "Test Falls", area: "Altadena", tags: ["waterfall"], description: "Cool creek." }));
    expect(text).toContain("Test Falls");
    expect(text).toContain("Altadena");
    expect(text).toContain("waterfall");
    expect(text).toContain("moderate");
    expect(text).toContain("Cool creek.");
  });
});
```

- [ ] **Step 2: Create `test/helpers/fixtures.ts`** (used by many later tests)

```ts
import type { Trail } from "../../src/domain/types";

export function makeTrail(overrides: Partial<Trail> = {}): Trail {
  return {
    id: "seed:test-trail",
    owner: "shared",
    name: "Test Trail",
    area: "Pasadena",
    trailhead: "Test trailhead",
    routeType: "loop",
    distanceMinMi: 2,
    distanceMaxMi: 2.5,
    gainMinFt: 200,
    gainMaxFt: 300,
    difficulty: "moderate",
    difficultyNote: null,
    tags: ["test"],
    description: "A trail used in tests.",
    status: "open",
    closedUntil: null,
    statusNote: null,
    statusChecked: "2026-10-01",
    sourceUrls: ["https://example.com/test-trail"],
    indexState: "pending",
    indexedAt: null,
    ...overrides,
  };
}
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/search-rules.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `src/domain/search-rules.ts`**

```ts
import { DIFFICULTY_RANK, SHARED_OWNER, type Difficulty, type Trail } from "./types";

export interface SearchConstraints {
  maxDistanceMi?: number;
  maxGainFt?: number;
  difficulty?: Difficulty;
}

export interface VectorMetadata {
  owner: string;
  status: string;
  difficulty_rank: number;
  distance_max_mi: number;
  gain_max_ft?: number;
}

export function checkConstraints(
  t: Pick<Trail, "distanceMaxMi" | "gainMaxFt" | "difficulty">,
  c: SearchConstraints,
): { ok: boolean; flags: string[] } {
  const flags: string[] = [];
  if (c.maxDistanceMi !== undefined && t.distanceMaxMi > c.maxDistanceMi) return { ok: false, flags };
  if (c.maxGainFt !== undefined) {
    if (t.gainMaxFt === null || t.gainMaxFt > c.maxGainFt) return { ok: false, flags };
  } else if (t.gainMaxFt === null) {
    flags.push("gain unknown");
  }
  if (c.difficulty !== undefined && t.difficulty !== c.difficulty) return { ok: false, flags };
  return { ok: true, flags };
}

export function buildVectorFilter(userId: string, c: SearchConstraints): Record<string, unknown> {
  const filter: Record<string, unknown> = { owner: { $in: [SHARED_OWNER, userId] } };
  if (c.maxDistanceMi !== undefined) filter.distance_max_mi = { $lte: c.maxDistanceMi };
  if (c.maxGainFt !== undefined) filter.gain_max_ft = { $lte: c.maxGainFt };
  if (c.difficulty !== undefined) filter.difficulty_rank = { $eq: DIFFICULTY_RANK[c.difficulty] };
  return filter;
}

export function toVectorMetadata(t: Trail): VectorMetadata {
  const meta: VectorMetadata = {
    owner: t.owner,
    status: t.status,
    difficulty_rank: DIFFICULTY_RANK[t.difficulty],
    distance_max_mi: t.distanceMaxMi,
  };
  if (t.gainMaxFt !== null) meta.gain_max_ft = t.gainMaxFt;
  return meta;
}

export function embeddingText(t: Trail): string {
  const distance =
    t.distanceMinMi === t.distanceMaxMi ? `${t.distanceMaxMi} miles` : `${t.distanceMinMi} to ${t.distanceMaxMi} miles`;
  return [
    `${t.name} in ${t.area}.`,
    `${t.difficulty} ${t.routeType}, ${distance}.`,
    t.tags.length ? `Tags: ${t.tags.join(", ")}.` : "",
    t.description,
  ]
    .filter(Boolean)
    .join(" ");
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/search-rules.test.ts` → PASS.

- [ ] **Step 6: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 4: Seed normalization and sources

**Files:**
- Create: `src/domain/seed.ts`
- Modify: `data/trails.seed.json` (add `source_urls` to every trail)
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes: `Trail`, `Difficulty`, `SHARED_OWNER`.
- Produces: `normalizeSeed(raw: unknown): Trail[]` (throws `ZodError` on invalid data; every returned trail has `owner: "shared"`, `id` prefixed `seed:`, `indexState: "pending"`).

- [ ] **Step 1: Add `source_urls` to every trail in `data/trails.seed.json`**

Add a `"source_urls": [...]` array (at least one `https://` URL) to each of the 18 trails, using this mapping (ids are the existing `id` values; keep every other field as is):

| id | source_urls |
|---|---|
| runyon-canyon-loop | https://www.alltrails.com/trail/us/california/runyon-canyon-trail |
| eagle-rock-canyon-trail | https://latrailhikers.com/hikes/eagle-rock-loop/ |
| solstice-canyon-malibu | https://modernhiker.com/hike/hiking-solstice-canyon/ |
| escondido-falls-malibu | https://outdoortravels101.com/escondido-falls/ |
| culver-city-stairs | https://www.theoutbound.com/california/hiking/baldwin-hills-scenic-overlook-trail |
| eaton-canyon-nature-center | https://trails.lacounty.gov/Trail/22/eaton-canyon-trail |
| eaton-canyon-pinecrest | https://modernhiker.com/hike/hiking-eaton-canyon/ and https://trails.lacounty.gov/Trail/22/eaton-canyon-trail |
| millard-falls | https://www.theoutbound.com/los-angeles/hiking/hike-to-millard-falls |
| gabrielino-jpl-brown-mountain-dam | https://www.pasadenanow.com/weekendr/hike-the-gabrielino-trail-from-jpl-to-brown-mountain-dam/ |
| hahamongna-watershed-loop | https://modernhiker.com/hike/hahamongna-watershed-loop/ |
| griffith-fern-dell-mount-hollywood | https://www.alltrails.com/trail/us/california/ferndell-to-mount-hollywood-summit |
| griffith-fern-dell-observatory | https://www.alltrails.com/trail/us/california/ferndell-to-the-west-observatory-loop-trail-to-griffith-observatory |
| griffith-helipad-cedar-grove-loop | https://www.hikespeak.com/los-angeles/griffith-park-hikes/ |
| deukmejian-dunsmore-le-mesnager-loop | https://www.alltrails.com/trail/us/california/deukmejian-wilderness-park-dunsmore-canyon-and-le-mesnager-loop-trails |
| mount-lukens-via-deukmejian | https://www.alltrails.com/trail/us/california/mount-lukens-via-dunsmore-canyon |
| la-tuna-canyon-trail | https://www.hikespeak.com/trails/la-tuna-canyon-park/ |
| verdugo-peak-from-la-tuna | https://www.otphiker.com/hikes/743.html |
| mugu-peak-point-mugu | find one reputable guide for Mugu Peak (Modern Hiker, AllTrails, or California State Parks) with a web search and use its URL |

Also remove the `"favorite"` key from each trail (author-specific; the loader ignores it, but the shared dataset should not carry it) and delete the `_readme` sentence about descriptions being placeholders only after the author has rewritten them (leave it for now).

- [ ] **Step 2: Write the failing tests `test/seed.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import seedJson from "../data/trails.seed.json";
import { normalizeSeed } from "../src/domain/seed";

describe("normalizeSeed", () => {
  const trails = normalizeSeed(seedJson);
  const byId = new Map(trails.map((t) => [t.id, t]));

  it("loads all seed trails as shared, pending, with seed: ids", () => {
    expect(trails.length).toBe(18);
    for (const t of trails) {
      expect(t.owner).toBe("shared");
      expect(t.id.startsWith("seed:")).toBe(true);
      expect(t.indexState).toBe("pending");
      expect(t.sourceUrls.length).toBeGreaterThan(0);
      expect(t.id.length).toBeLessThanOrEqual(64);
    }
  });
  it("has unique ids", () => {
    expect(new Set(trails.map((t) => t.id)).size).toBe(trails.length);
  });
  it("normalizes difficulty text and keeps the original as a note", () => {
    const solstice = byId.get("seed:solstice-canyon-malibu")!;
    expect(solstice.difficulty).toBe("moderate");
    expect(solstice.difficultyNote).toBe("easy to moderate");
    expect(byId.get("seed:verdugo-peak-from-la-tuna")!.difficultyNote).toBeNull();
  });
  it("keeps the Eaton closures with their dates and notes", () => {
    for (const id of ["seed:eaton-canyon-nature-center", "seed:eaton-canyon-pinecrest"]) {
      const t = byId.get(id)!;
      expect(t.status).toBe("closed");
      expect(t.closedUntil).toBe("2027-12-31");
      expect(t.statusNote).toBeTruthy();
    }
  });
  it("uses null for unknown gain", () => {
    const helipad = byId.get("seed:griffith-helipad-cedar-grove-loop")!;
    expect(helipad.gainMinFt).toBeNull();
    expect(helipad.gainMaxFt).toBeNull();
  });
  it("rejects malformed seed data", () => {
    expect(() => normalizeSeed({ trails: [{ id: "x" }] })).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/seed.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `src/domain/seed.ts`**

```ts
import { z } from "zod";
import { SHARED_OWNER, type Difficulty, type Trail } from "./types";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableNum = z.number().nonnegative().nullable();

const SeedTrail = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  area: z.string().min(1),
  trailhead: z.string().min(1),
  route_type: z.string().min(1),
  distance_mi: z.tuple([z.number().positive(), z.number().positive()]),
  gain_ft: z.tuple([nullableNum, nullableNum]),
  difficulty: z.string().min(1),
  status: z.enum(["open", "closed", "verify"]),
  closed_until: isoDate.nullable(),
  status_note: z.string().optional(),
  status_checked: isoDate,
  source_urls: z.array(z.url()).min(1),
  tags: z.array(z.string()),
  description: z.string().min(1).max(2000),
});

const SeedFile = z.object({ trails: z.array(SeedTrail).min(1) });

function mapDifficulty(raw: string): Difficulty {
  const s = raw.toLowerCase();
  if (s.includes("hard")) return "hard";
  if (s.includes("moderate")) return "moderate";
  return "easy";
}

export function normalizeSeed(raw: unknown): Trail[] {
  const file = SeedFile.parse(raw);
  return file.trails.map((s): Trail => {
    const difficulty = mapDifficulty(s.difficulty);
    return {
      id: `seed:${s.id}`,
      owner: SHARED_OWNER,
      name: s.name,
      area: s.area,
      trailhead: s.trailhead,
      routeType: s.route_type,
      distanceMinMi: s.distance_mi[0],
      distanceMaxMi: s.distance_mi[1],
      gainMinFt: s.gain_ft[0],
      gainMaxFt: s.gain_ft[1],
      difficulty,
      difficultyNote: s.difficulty.toLowerCase() === difficulty ? null : s.difficulty,
      tags: s.tags,
      description: s.description,
      status: s.status,
      closedUntil: s.closed_until,
      statusNote: s.status_note ?? null,
      statusChecked: s.status_checked,
      sourceUrls: s.source_urls,
      indexState: "pending",
      indexedAt: null,
    };
  });
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/seed.test.ts` → PASS. If a trail fails the schema (for example a `gain_ft` of `null` in only one slot, or a missing `closed_until`), fix the data file, not the schema.

- [ ] **Step 6: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 5: D1 schema access (owner-scoped repository)

**Files:**
- Create: `src/db/trails-repo.ts`
- Test: `test/trails-repo.test.ts`

**Interfaces:**
- Consumes: `Trail`, `IndexState`, `SHARED_OWNER`; `applySchema`, `clearTrails`, `makeTrail`.
- Produces: `class TrailsRepo` with
  - `constructor(db: D1Database)`
  - `upsert(t: Trail, opts?: { maxOwned?: number }): Promise<boolean>` (false if the id exists under a different owner, or the owner is at `maxOwned` and the row is new; the cap check is atomic with the insert)
  - `getVisible(id: string, userId: string): Promise<Trail | null>`
  - `getVisibleByIds(ids: string[], userId: string): Promise<Trail[]>`
  - `findVisibleByName(name: string, userId: string): Promise<Trail[]>`
  - `countOwned(userId: string): Promise<number>`
  - `deleteOwned(id: string, userId: string): Promise<boolean>`
  - `setIndexState(id: string, state: IndexState, now: Date): Promise<void>`
  - `setIndexStateMany(ids: string[], state: IndexState, now: Date): Promise<void>` (batched)
  - `upsertMany(trails: Trail[]): Promise<void>` (batched; no owner cap)
  - `listForReindex(limit: number): Promise<Trail[]>` (rows not yet `indexed`, pending first)
  - `countUnindexed(): Promise<number>`, `markAllPending(): Promise<void>`

- [ ] **Step 1: Write the failing tests `test/trails-repo.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { applySchema, clearTrails } from "./helpers/db";
import { makeTrail } from "./helpers/fixtures";

const db = (env as unknown as { DB: D1Database }).DB;
let repo: TrailsRepo;

beforeAll(async () => applySchema(db));
beforeEach(async () => {
  await clearTrails(db);
  repo = new TrailsRepo(db);
});

describe("TrailsRepo visibility", () => {
  it("round-trips a trail including arrays and nulls", async () => {
    const t = makeTrail({ id: "seed:a", gainMinFt: null, gainMaxFt: null, tags: ["x", "y"], difficultyNote: "easy to moderate" });
    expect(await repo.upsert(t)).toBe(true);
    expect(await repo.getVisible("seed:a", "42")).toEqual(t);
  });
  it("shows shared trails to everyone and private trails only to their owner", async () => {
    await repo.upsert(makeTrail({ id: "seed:s", owner: "shared" }));
    await repo.upsert(makeTrail({ id: "u:a", owner: "1" }));
    expect(await repo.getVisible("seed:s", "2")).not.toBeNull();
    expect(await repo.getVisible("u:a", "1")).not.toBeNull();
    expect(await repo.getVisible("u:a", "2")).toBeNull();
    const ids = (await repo.getVisibleByIds(["seed:s", "u:a"], "2")).map((t) => t.id);
    expect(ids).toEqual(["seed:s"]);
  });
  it("handles more than 90 ids without hitting D1's 100-parameter limit", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) {
      const id = `seed:t${i}`;
      ids.push(id);
      await repo.upsert(makeTrail({ id, name: `Trail ${i}` }));
    }
    expect((await repo.getVisibleByIds(ids, "1")).length).toBe(150);
  });
  it("finds visible trails by case-insensitive exact name and never returns foreign private ones", async () => {
    await repo.upsert(makeTrail({ id: "seed:r", name: "Runyon Canyon Loop" }));
    await repo.upsert(makeTrail({ id: "u:mine", owner: "1", name: "Runyon Canyon Loop" }));
    await repo.upsert(makeTrail({ id: "u:theirs", owner: "2", name: "Runyon Canyon Loop" }));
    const found = (await repo.findVisibleByName("runyon canyon loop", "1")).map((t) => t.id).sort();
    expect(found).toEqual(["seed:r", "u:mine"]);
  });
});

describe("TrailsRepo writes", () => {
  it("does not let one owner overwrite another owner's row with the same id", async () => {
    await repo.upsert(makeTrail({ id: "u:x", owner: "1", name: "Mine" }));
    expect(await repo.upsert(makeTrail({ id: "u:x", owner: "2", name: "Hijack" }))).toBe(false);
    expect((await repo.getVisible("u:x", "1"))?.name).toBe("Mine");
  });
  it("deleteOwned deletes only the caller's own rows and never shared rows", async () => {
    await repo.upsert(makeTrail({ id: "seed:s", owner: "shared" }));
    await repo.upsert(makeTrail({ id: "u:a", owner: "1" }));
    expect(await repo.deleteOwned("seed:s", "1")).toBe(false);
    expect(await repo.deleteOwned("seed:s", "shared")).toBe(false);
    expect(await repo.deleteOwned("u:a", "2")).toBe(false);
    expect(await repo.deleteOwned("u:a", "1")).toBe(true);
    expect(await repo.getVisible("seed:s", "1")).not.toBeNull();
    expect(await repo.getVisible("u:a", "1")).toBeNull();
  });
  it("counts owned trails and tracks index state", async () => {
    await repo.upsert(makeTrail({ id: "u:a", owner: "1" }));
    await repo.upsert(makeTrail({ id: "u:b", owner: "1", name: "B" }));
    expect(await repo.countOwned("1")).toBe(2);
    await repo.setIndexState("u:a", "indexed", new Date("2026-10-07T12:00:00Z"));
    const a = await repo.getVisible("u:a", "1");
    expect(a?.indexState).toBe("indexed");
    expect(a?.indexedAt).toBe("2026-10-07T12:00:00.000Z");
    expect((await repo.listForReindex(10)).map((t) => t.id)).toEqual(["u:b"]);
    expect(await repo.countUnindexed()).toBe(1);
    await repo.markAllPending();
    expect(await repo.countUnindexed()).toBe(2);
  });
  it("batches many upserts and index-state updates", async () => {
    const trails = Array.from({ length: 120 }, (_, i) => makeTrail({ id: `seed:m${i}`, name: `M${i}` }));
    await repo.upsertMany(trails);
    expect(await repo.countUnindexed()).toBe(120);
    expect((await repo.listForReindex(20)).length).toBe(20);
    await repo.setIndexStateMany(trails.map((t) => t.id), "indexed", new Date("2026-10-07T12:00:00Z"));
    expect(await repo.countUnindexed()).toBe(0);
  });
});

describe("TrailsRepo owner cap", () => {
  it("refuses a new row at the cap but still allows updating an existing one", async () => {
    await repo.upsert(makeTrail({ id: "u:a", owner: "1", name: "A" }), { maxOwned: 2 });
    await repo.upsert(makeTrail({ id: "u:b", owner: "1", name: "B" }), { maxOwned: 2 });
    expect(await repo.upsert(makeTrail({ id: "u:c", owner: "1", name: "C" }), { maxOwned: 2 })).toBe(false);
    expect(await repo.countOwned("1")).toBe(2);
    expect(await repo.upsert(makeTrail({ id: "u:a", owner: "1", name: "A2" }), { maxOwned: 2 })).toBe(true);
    expect((await repo.getVisible("u:a", "1"))?.name).toBe("A2");
  });
  it("does not let a capped insert hijack another owner's id", async () => {
    await repo.upsert(makeTrail({ id: "u:x", owner: "1", name: "Mine" }));
    expect(await repo.upsert(makeTrail({ id: "u:x", owner: "2", name: "Hijack" }), { maxOwned: 5 })).toBe(false);
    expect((await repo.getVisible("u:x", "1"))?.name).toBe("Mine");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/trails-repo.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/db/trails-repo.ts`**

```ts
import { SHARED_OWNER, type Difficulty, type IndexState, type Status, type Trail } from "../domain/types";

const COLS = [
  "id", "owner", "name", "area", "trailhead", "route_type", "distance_min_mi", "distance_max_mi",
  "gain_min_ft", "gain_max_ft", "difficulty", "difficulty_note", "tags", "description", "status",
  "closed_until", "status_note", "status_checked", "source_urls", "index_state", "indexed_at",
].join(", ");

const UPDATABLE = COLS.split(", ").filter((c) => c !== "id" && c !== "owner");
const CHUNK = 90; // D1 allows 100 bound parameters; we also bind the owner
const BATCH = 50; // statements per db.batch() call

type Row = Record<string, unknown>;

function fromRow(r: Row): Trail {
  return {
    id: r.id as string,
    owner: r.owner as string,
    name: r.name as string,
    area: r.area as string,
    trailhead: r.trailhead as string,
    routeType: r.route_type as string,
    distanceMinMi: r.distance_min_mi as number,
    distanceMaxMi: r.distance_max_mi as number,
    gainMinFt: (r.gain_min_ft as number | null) ?? null,
    gainMaxFt: (r.gain_max_ft as number | null) ?? null,
    difficulty: r.difficulty as Difficulty,
    difficultyNote: (r.difficulty_note as string | null) ?? null,
    tags: JSON.parse(r.tags as string) as string[],
    description: r.description as string,
    status: r.status as Status,
    closedUntil: (r.closed_until as string | null) ?? null,
    statusNote: (r.status_note as string | null) ?? null,
    statusChecked: r.status_checked as string,
    sourceUrls: JSON.parse(r.source_urls as string) as string[],
    indexState: r.index_state as IndexState,
    indexedAt: (r.indexed_at as string | null) ?? null,
  };
}

function toValues(t: Trail): unknown[] {
  return [
    t.id, t.owner, t.name, t.area, t.trailhead, t.routeType, t.distanceMinMi, t.distanceMaxMi,
    t.gainMinFt, t.gainMaxFt, t.difficulty, t.difficultyNote, JSON.stringify(t.tags), t.description,
    t.status, t.closedUntil, t.statusNote, t.statusChecked, JSON.stringify(t.sourceUrls),
    t.indexState, t.indexedAt,
  ];
}

export class TrailsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * Returns false when nothing was written: the id exists under a different owner, or (with
   * maxOwned) the owner is at the cap and this would be a new row. The cap check and the insert
   * are one SQL statement, so concurrent adds cannot overshoot the cap.
   */
  async upsert(t: Trail, opts: { maxOwned?: number } = {}): Promise<boolean> {
    const res = await this.upsertStatement(t, opts).run();
    return res.meta.changes > 0;
  }

  private upsertStatement(t: Trail, opts: { maxOwned?: number } = {}): D1PreparedStatement {
    const placeholders = COLS.split(", ").map(() => "?").join(", ");
    const set = UPDATABLE.map((c) => `${c} = excluded.${c}`).join(", ");
    const conflict = `ON CONFLICT(id) DO UPDATE SET ${set} WHERE trails.owner = excluded.owner`;
    if (opts.maxOwned === undefined) {
      return this.db.prepare(`INSERT INTO trails (${COLS}) VALUES (${placeholders}) ${conflict}`).bind(...toValues(t));
    }
    return this.db
      .prepare(
        `INSERT INTO trails (${COLS}) SELECT ${placeholders}
         WHERE (SELECT COUNT(*) FROM trails WHERE owner = ?) < ? OR EXISTS (SELECT 1 FROM trails WHERE id = ?)
         ${conflict}`,
      )
      .bind(...toValues(t), t.owner, opts.maxOwned, t.id);
  }

  /** Many rows in a few round trips (db.batch), for seeding. */
  async upsertMany(trails: Trail[]): Promise<void> {
    for (let i = 0; i < trails.length; i += BATCH) {
      await this.db.batch(trails.slice(i, i + BATCH).map((t) => this.upsertStatement(t)));
    }
  }

  async getVisible(id: string, userId: string): Promise<Trail | null> {
    const row = await this.db
      .prepare(`SELECT ${COLS} FROM trails WHERE id = ? AND owner IN (?, ?)`)
      .bind(id, SHARED_OWNER, userId)
      .first<Row>();
    return row ? fromRow(row) : null;
  }

  async getVisibleByIds(ids: string[], userId: string): Promise<Trail[]> {
    const out: Trail[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const marks = chunk.map(() => "?").join(", ");
      const { results } = await this.db
        .prepare(`SELECT ${COLS} FROM trails WHERE owner IN (?, ?) AND id IN (${marks})`)
        .bind(SHARED_OWNER, userId, ...chunk)
        .all<Row>();
      out.push(...results.map(fromRow));
    }
    return out;
  }

  async findVisibleByName(name: string, userId: string): Promise<Trail[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM trails WHERE owner IN (?, ?) AND name = ? COLLATE NOCASE`)
      .bind(SHARED_OWNER, userId, name)
      .all<Row>();
    return results.map(fromRow);
  }

  async countOwned(userId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM trails WHERE owner = ?")
      .bind(userId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async deleteOwned(id: string, userId: string): Promise<boolean> {
    if (userId === SHARED_OWNER) return false;
    const res = await this.db.prepare("DELETE FROM trails WHERE id = ? AND owner = ?").bind(id, userId).run();
    return res.meta.changes > 0;
  }

  async setIndexState(id: string, state: IndexState, now: Date): Promise<void> {
    await this.db
      .prepare("UPDATE trails SET index_state = ?, indexed_at = ? WHERE id = ?")
      .bind(state, state === "indexed" ? now.toISOString() : null, id)
      .run();
  }

  async setIndexStateMany(ids: string[], state: IndexState, now: Date): Promise<void> {
    const at = state === "indexed" ? now.toISOString() : null;
    for (let i = 0; i < ids.length; i += BATCH) {
      await this.db.batch(
        ids
          .slice(i, i + BATCH)
          .map((id) => this.db.prepare("UPDATE trails SET index_state = ?, indexed_at = ? WHERE id = ?").bind(state, at, id)),
      );
    }
  }

  /** Rows still needing an embedding (pending first, then failed), at most `limit`. */
  async listForReindex(limit: number): Promise<Trail[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLS} FROM trails WHERE index_state != 'indexed'
         ORDER BY CASE index_state WHEN 'pending' THEN 0 ELSE 1 END, id LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return results.map(fromRow);
  }

  async countUnindexed(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM trails WHERE index_state != 'indexed'").first<{ n: number }>();
    return row?.n ?? 0;
  }

  async markAllPending(): Promise<void> {
    await this.db.prepare("UPDATE trails SET index_state = 'pending', indexed_at = NULL").run();
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/trails-repo.test.ts` → PASS.

- [ ] **Step 5: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 6: Ports, fakes, and Cloudflare adapters

**Files:**
- Create: `src/ports.ts`, `src/adapters/workers-ai.ts`, `src/adapters/vectorize.ts`, `src/services/deps.ts`, `test/helpers/fakes.ts`
- Test: `test/fakes.test.ts`, `test/adapters.test.ts`

**Interfaces:**
- Consumes: `VectorMetadata` from `src/domain/search-rules.ts`; `TrailsRepo`.
- Produces:
  - `interface Embedder { embed(text: string): Promise<number[]>; embedMany(texts: string[]): Promise<number[][]> }`
  - `interface VectorRecord { id: string; values: number[]; metadata: VectorMetadata }`
  - `interface VectorStore { upsert(records: VectorRecord[]): Promise<void>; query(values: number[], opts: { topK: number; filter: Record<string, unknown> }): Promise<{ id: string; score: number }[]>; deleteByIds(ids: string[]): Promise<void> }`
  - `class WorkersAiEmbedder implements Embedder` (`constructor(ai: Ai)`), `class VectorizeStore implements VectorStore` (`constructor(index: Vectorize)`)
  - `interface Deps { repo: TrailsRepo; embedder: Embedder; vectors: VectorStore; now: () => Date }`
  - Test fakes: `class HashEmbedder implements Embedder`, `class InMemoryVectorStore implements VectorStore` with `failNextUpsert(): void` and `injectRaw(id: string, values: number[], metadata: VectorMetadata): void`, `class FailingEmbedder implements Embedder`.

- [ ] **Step 1: Create `src/ports.ts` and `src/services/deps.ts`**

```ts
// src/ports.ts
import type { VectorMetadata } from "./domain/search-rules";

export interface Embedder {
  embed(text: string): Promise<number[]>;
  /** One round trip for many texts (Workers AI accepts a text array); keeps subrequests low. */
  embedMany(texts: string[]): Promise<number[][]>;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  query(
    values: number[],
    opts: { topK: number; filter: Record<string, unknown> },
  ): Promise<{ id: string; score: number }[]>;
  deleteByIds(ids: string[]): Promise<void>;
}
```

```ts
// src/services/deps.ts
import type { TrailsRepo } from "../db/trails-repo";
import type { Embedder, VectorStore } from "../ports";

export interface Deps {
  repo: TrailsRepo;
  embedder: Embedder;
  vectors: VectorStore;
  now: () => Date;
}
```

- [ ] **Step 2: Create the fakes `test/helpers/fakes.ts`**

```ts
import type { VectorMetadata } from "../../src/domain/search-rules";
import type { Embedder, VectorRecord, VectorStore } from "../../src/ports";

const DIMS = 256;

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic bag-of-words embedder: shared words => higher cosine similarity. */
export class HashEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(DIMS).fill(0);
    for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[hash(w) % DIMS]! += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

export class FailingEmbedder implements Embedder {
  async embed(): Promise<number[]> {
    throw new Error("embedding unavailable");
  }
  async embedMany(): Promise<number[][]> {
    throw new Error("embedding unavailable");
  }
}

function matches(meta: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const v = meta[key];
    if (typeof cond !== "object" || cond === null) {
      if (v !== cond) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(cond as Record<string, unknown>)) {
      if (op === "$eq") { if (v !== arg) return false; }
      else if (op === "$in") { if (!(arg as unknown[]).includes(v)) return false; }
      else if (op === "$lte") { if (typeof v !== "number" || v > (arg as number)) return false; }
      else throw new Error(`fake vector store: unsupported operator ${op}`);
    }
  }
  return true;
}

export class InMemoryVectorStore implements VectorStore {
  readonly records = new Map<string, VectorRecord>();
  private failUpsert = false;

  failNextUpsert(): void {
    this.failUpsert = true;
  }
  /** Plant a vector directly, e.g. a stale id or a foreign user's vector. */
  injectRaw(id: string, values: number[], metadata: VectorMetadata): void {
    this.records.set(id, { id, values, metadata });
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (this.failUpsert) {
      this.failUpsert = false;
      throw new Error("vectorize unavailable");
    }
    for (const r of records) this.records.set(r.id, r);
  }

  async query(values: number[], opts: { topK: number; filter: Record<string, unknown> }) {
    const scored = [...this.records.values()]
      .filter((r) => matches(r.metadata as unknown as Record<string, unknown>, opts.filter))
      .map((r) => ({ id: r.id, score: r.values.reduce((s, x, i) => s + x * (values[i] ?? 0), 0) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.topK);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }
}
```

- [ ] **Step 3: Write failing tests `test/fakes.test.ts` and `test/adapters.test.ts`**

`test/fakes.test.ts` (the fakes must behave like Vectorize for the operators we use):
```ts
import { describe, expect, it } from "vitest";
import { HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";

const meta = (o: Partial<{ owner: string; distance_max_mi: number }> = {}) => ({
  owner: "shared", status: "open", difficulty_rank: 2, distance_max_mi: 2, ...o,
});

describe("fakes", () => {
  it("ranks the text sharing more words higher", async () => {
    const e = new HashEmbedder();
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: "a", values: await e.embed("creek waterfall shade"), metadata: meta() },
      { id: "b", values: await e.embed("exposed summit radio towers"), metadata: meta() },
    ]);
    const hits = await store.query(await e.embed("shady waterfall creek"), { topK: 2, filter: { owner: { $in: ["shared"] } } });
    expect(hits[0]?.id).toBe("a");
  });
  it("applies $in, $lte and $eq filters and rejects unsupported operators", async () => {
    const store = new InMemoryVectorStore();
    const v = [1, 0];
    await store.upsert([
      { id: "mine", values: v, metadata: meta({ owner: "1", distance_max_mi: 5 }) },
      { id: "theirs", values: v, metadata: meta({ owner: "2", distance_max_mi: 1 }) },
    ]);
    const ids = async (filter: Record<string, unknown>) => (await store.query(v, { topK: 10, filter })).map((h) => h.id);
    expect(await ids({ owner: { $in: ["shared", "1"] } })).toEqual(["mine"]);
    expect(await ids({ distance_max_mi: { $lte: 2 } })).toEqual(["theirs"]);
    expect(await ids({ owner: { $eq: "2" } })).toEqual(["theirs"]);
    await expect(ids({ owner: { $nope: 1 } })).rejects.toThrow(/unsupported/);
  });
  it("can fail one upsert on demand", async () => {
    const store = new InMemoryVectorStore();
    store.failNextUpsert();
    await expect(store.upsert([])).rejects.toThrow();
    await expect(store.upsert([])).resolves.toBeUndefined();
  });
});
```

`test/adapters.test.ts` (adapters tested against hand-rolled stubs of the Cloudflare bindings):
```ts
import { describe, expect, it } from "vitest";
import { VectorizeStore } from "../src/adapters/vectorize";
import { WorkersAiEmbedder } from "../src/adapters/workers-ai";

describe("WorkersAiEmbedder", () => {
  it("calls bge-base with cls pooling and returns the first 768-dim vector", async () => {
    const calls: unknown[] = [];
    const ai = { run: async (model: string, input: unknown) => { calls.push([model, input]); return { data: [new Array(768).fill(0.1)] }; } };
    const v = await new WorkersAiEmbedder(ai as unknown as Ai).embed("hello");
    expect(v.length).toBe(768);
    expect(calls[0]).toEqual(["@cf/baai/bge-base-en-v1.5", { text: ["hello"], pooling: "cls" }]);
  });
  it("throws on a malformed response", async () => {
    const ai = { run: async () => ({ data: [[1, 2, 3]] }) };
    await expect(new WorkersAiEmbedder(ai as unknown as Ai).embed("x")).rejects.toThrow(/embedding/);
  });
  it("embedMany sends one call per 50 texts and keeps order", async () => {
    const sizes: number[] = [];
    const ai = { run: async (_m: string, input: { text: string[] }) => { sizes.push(input.text.length); return { data: input.text.map(() => new Array(768).fill(0.2)) }; } };
    const out = await new WorkersAiEmbedder(ai as unknown as Ai).embedMany(Array.from({ length: 120 }, (_, i) => `t${i}`));
    expect(out.length).toBe(120);
    expect(sizes).toEqual([50, 50, 20]);
  });
});

describe("VectorizeStore", () => {
  it("queries with returnMetadata none and maps matches", async () => {
    let seen: unknown;
    const index = { query: async (_v: number[], opts: unknown) => { seen = opts; return { matches: [{ id: "a", score: 0.9 }] }; } };
    const hits = await new VectorizeStore(index as unknown as Vectorize).query([1], { topK: 100, filter: { owner: { $in: ["shared"] } } });
    expect(hits).toEqual([{ id: "a", score: 0.9 }]);
    expect(seen).toEqual({ topK: 100, filter: { owner: { $in: ["shared"] } }, returnMetadata: "none" });
  });
  it("upserts in batches of at most 500", async () => {
    const sizes: number[] = [];
    const index = { upsert: async (batch: unknown[]) => { sizes.push(batch.length); return { mutationId: "m" }; } };
    const recs = Array.from({ length: 1200 }, (_, i) => ({
      id: `id${i}`, values: [0], metadata: { owner: "shared", status: "open", difficulty_rank: 1, distance_max_mi: 1 },
    }));
    await new VectorizeStore(index as unknown as Vectorize).upsert(recs);
    expect(sizes).toEqual([500, 500, 200]);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/fakes.test.ts test/adapters.test.ts` → the adapter tests FAIL (module not found); fakes tests PASS.

- [ ] **Step 5: Implement the adapters**

`src/adapters/workers-ai.ts`:
```ts
import type { Embedder } from "../ports";

const MODEL = "@cf/baai/bge-base-en-v1.5";
const DIMENSIONS = 768;
const MAX_TEXTS_PER_CALL = 50;

export class WorkersAiEmbedder implements Embedder {
  constructor(private readonly ai: Ai) {}

  async embed(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0]!;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_CALL) {
      const chunk = texts.slice(i, i + MAX_TEXTS_PER_CALL);
      const res = (await this.ai.run(MODEL, { text: chunk, pooling: "cls" })) as { data?: number[][] };
      if (!res.data || res.data.length !== chunk.length || res.data.some((v) => v.length !== DIMENSIONS)) {
        throw new Error("embedding failed: unexpected response shape");
      }
      out.push(...res.data);
    }
    return out;
  }
}
```

`src/adapters/vectorize.ts`:
```ts
import type { VectorRecord, VectorStore } from "../ports";

const BATCH = 500;

export class VectorizeStore implements VectorStore {
  constructor(private readonly index: Vectorize) {}

  async upsert(records: VectorRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH).map((r) => ({
        id: r.id,
        values: r.values,
        metadata: r.metadata as unknown as Record<string, VectorizeVectorMetadata>,
      }));
      await this.index.upsert(batch);
    }
  }

  async query(values: number[], opts: { topK: number; filter: Record<string, unknown> }) {
    const res = await this.index.query(values, {
      topK: opts.topK,
      filter: opts.filter as VectorizeVectorMetadataFilter,
      returnMetadata: "none",
    });
    return res.matches.map((m) => ({ id: m.id, score: m.score }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.index.deleteByIds(ids);
  }
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/fakes.test.ts test/adapters.test.ts && npm run typecheck`
Expected: PASS. If `tsc` objects to a Cloudflare type name (`VectorizeVectorMetadataFilter`, `VectorizeVectorMetadata`), use the equivalent name from `@cloudflare/workers-types`; the runtime behavior and tests stay the same.

- [ ] **Step 7: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 7: Search service

**Files:**
- Create: `src/services/search.ts`
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `Deps`, `evaluateClosure`, `laToday`, `checkConstraints`, `buildVectorFilter`, `toVectorMetadata`, `embeddingText`, `TrailsRepo` methods.
- Produces:
  - `interface SearchInput extends SearchConstraints { query: string; includeClosed?: boolean; date?: string; limit?: number }`
  - `interface SearchHit { trail: Trail; score: number | null; availability: "available" | "excluded" | "verify"; closedThrough: string | null; flags: string[] }`
  - `searchHikes(deps: Deps, userId: string, input: SearchInput): Promise<SearchHit[]>`
  - `indexTrail(deps: Deps, t: Trail): Promise<void>` (embeds and upserts one trail's vector; used by tests and later services)

- [ ] **Step 1: Write the failing tests `test/search.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { indexTrail, searchHikes } from "../src/services/search";
import type { Deps } from "../src/services/deps";
import type { Trail } from "../src/domain/types";
import { toVectorMetadata } from "../src/domain/search-rules";
import { applySchema, clearTrails } from "./helpers/db";
import { HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";
import { makeTrail } from "./helpers/fixtures";

const db = (env as unknown as { DB: D1Database }).DB;
let deps: Deps;
let vectors: InMemoryVectorStore;

async function add(t: Trail) {
  await deps.repo.upsert(t);
  await indexTrail(deps, t);
}

beforeAll(async () => applySchema(db));
beforeEach(async () => {
  await clearTrails(db);
  vectors = new InMemoryVectorStore();
  deps = { repo: new TrailsRepo(db), embedder: new HashEmbedder(), vectors, now: () => new Date("2026-10-07T20:00:00Z") };
  await add(makeTrail({ id: "seed:falls", name: "Hidden Falls", description: "Shady creek walk to a waterfall.", tags: ["waterfall", "creek"] }));
  await add(makeTrail({ id: "seed:summit", name: "Radio Peak", description: "Exposed fire road to a summit with radio towers.", tags: ["summit"], distanceMinMi: 7, distanceMaxMi: 7.5, difficulty: "hard" }));
  await add(makeTrail({ id: "seed:eaton", name: "Eaton Canyon Falls", description: "Creek canyon waterfall hike.", tags: ["waterfall", "creek"], status: "closed", closedUntil: "2027-12-31", statusNote: "Closed by LA County" }));
});

describe("searchHikes", () => {
  it("ranks by meaning and hides closed trails by default", async () => {
    const hits = await searchHikes(deps, "42", { query: "shady creek waterfall" });
    expect(hits[0]?.trail.id).toBe("seed:falls");
    expect(hits.some((h) => h.trail.id === "seed:eaton")).toBe(false);
  });
  it("returns closed trails with their reopening date when include_closed is set", async () => {
    const hits = await searchHikes(deps, "42", { query: "creek canyon waterfall", includeClosed: true });
    const eaton = hits.find((h) => h.trail.id === "seed:eaton");
    expect(eaton).toMatchObject({ availability: "excluded", closedThrough: "2027-12-31" });
  });
  it("always returns a trail searched by exact name, with its status", async () => {
    const hits = await searchHikes(deps, "42", { query: "Eaton Canyon Falls" });
    expect(hits[0]?.trail.id).toBe("seed:eaton");
    expect(hits[0]?.availability).toBe("excluded");
    expect(hits[0]?.flags.join(" ")).toMatch(/exact name match/);
  });
  it("applies the date parameter to closures (the day after closed_until is verify)", async () => {
    const hits = await searchHikes(deps, "42", { query: "creek canyon waterfall", date: "2028-01-01" });
    expect(hits.find((h) => h.trail.id === "seed:eaton")?.availability).toBe("verify");
  });
  it("matches distance on the upper bound", async () => {
    const hits = await searchHikes(deps, "42", { query: "hike", maxDistanceMi: 3 });
    expect(hits.map((h) => h.trail.id)).not.toContain("seed:summit");
  });
  it("shows a user their own private hikes but never another user's", async () => {
    await add(makeTrail({ id: "u:mine", owner: "1", name: "Secret Spot", description: "Private hidden waterfall.", tags: ["waterfall"] }));
    const mine = await searchHikes(deps, "1", { query: "private hidden waterfall" });
    const theirs = await searchHikes(deps, "2", { query: "private hidden waterfall" });
    expect(mine.map((h) => h.trail.id)).toContain("u:mine");
    expect(theirs.map((h) => h.trail.id)).not.toContain("u:mine");
  });
  it("drops stale vector ids (missing from D1) and injected foreign vectors without crashing", async () => {
    const v = await deps.embedder.embed("private hidden waterfall");
    vectors.injectRaw("u:ghost", v, toVectorMetadata(makeTrail({ id: "u:ghost", owner: "1" }))); // not in D1
    await deps.repo.upsert(makeTrail({ id: "u:foreign", owner: "9", name: "Foreign", description: "private hidden waterfall" }));
    vectors.injectRaw("u:foreign", v, { ...toVectorMetadata(makeTrail({ owner: "shared" })), owner: "shared" }); // lies about its owner
    const ids = (await searchHikes(deps, "1", { query: "private hidden waterfall" })).map((h) => h.trail.id);
    expect(ids).not.toContain("u:ghost");
    expect(ids).not.toContain("u:foreign"); // D1 hydration re-checks ownership
  });
  it("respects limit", async () => {
    expect((await searchHikes(deps, "42", { query: "hike", limit: 1 })).length).toBe(1);
  });
  it("returns at most 10 results by default", async () => {
    for (let i = 0; i < 12; i++) {
      await add(makeTrail({ id: `seed:bulk${i}`, name: `Bulk ${i}`, description: "common bulk words" }));
    }
    expect((await searchHikes(deps, "42", { query: "common bulk words" })).length).toBe(10);
  });
  it("flags, but still returns, an exact-name match that falls outside the filters", async () => {
    await add(makeTrail({ id: "seed:long", name: "Long Loop", distanceMinMi: 2.8, distanceMaxMi: 3.5, description: "A long loop." }));
    const hits = await searchHikes(deps, "42", { query: "Long Loop", maxDistanceMi: 3 });
    expect(hits[0]?.trail.id).toBe("seed:long");
    expect(hits[0]?.flags).toContain("outside your filters");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/search.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/services/search.ts`**

```ts
import { evaluateClosure, laToday, type ClosureResult } from "../domain/closure";
import {
  buildVectorFilter,
  checkConstraints,
  embeddingText,
  toVectorMetadata,
  type SearchConstraints,
} from "../domain/search-rules";
import type { Trail } from "../domain/types";
import type { Deps } from "./deps";

export interface SearchInput extends SearchConstraints {
  query: string;
  includeClosed?: boolean;
  date?: string;
  limit?: number;
}

export interface SearchHit {
  trail: Trail;
  score: number | null;
  availability: ClosureResult["availability"];
  closedThrough: string | null;
  flags: string[];
}

const CANDIDATES = 100; // Vectorize max topK when metadata is not returned
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export async function indexTrail(deps: Deps, t: Trail): Promise<void> {
  const values = await deps.embedder.embed(embeddingText(t));
  await deps.vectors.upsert([{ id: t.id, values, metadata: toVectorMetadata(t) }]);
}

export async function searchHikes(deps: Deps, userId: string, input: SearchInput): Promise<SearchHit[]> {
  const date = input.date ?? laToday(deps.now());
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const query = input.query.trim();

  const vector = await deps.embedder.embed(query);
  const matches = await deps.vectors.query(vector, { topK: CANDIDATES, filter: buildVectorFilter(userId, input) });
  // D1 is the authorization boundary: ids that are missing or not visible to this user vanish here.
  const visible = new Map((await deps.repo.getVisibleByIds(matches.map((m) => m.id), userId)).map((t) => [t.id, t]));

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const trail = visible.get(m.id);
    if (!trail) continue;
    const constraint = checkConstraints(trail, input);
    if (!constraint.ok) continue;
    const closure = evaluateClosure(trail, date);
    if (closure.availability === "excluded" && !input.includeClosed) continue;
    hits.push({
      trail,
      score: m.score,
      availability: closure.availability,
      closedThrough: closure.closedThrough,
      flags: [...closure.flags, ...constraint.flags],
    });
    seen.add(trail.id);
  }

  // A trail asked for by exact name is always returned, with its status, even if closed or not yet indexed.
  const named: SearchHit[] = [];
  for (const trail of await deps.repo.findVisibleByName(query, userId)) {
    const closure = evaluateClosure(trail, date);
    const constraint = checkConstraints(trail, input);
    named.push({
      trail,
      score: null,
      availability: closure.availability,
      closedThrough: closure.closedThrough,
      flags: ["exact name match", ...closure.flags, ...(constraint.ok ? constraint.flags : ["outside your filters"])],
    });
  }
  const namedIds = new Set(named.map((h) => h.trail.id));
  return [...named, ...hits.filter((h) => !namedIds.has(h.trail.id))].slice(0, limit);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/search.test.ts` → PASS.

- [ ] **Step 5: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 8: Add, delete, and reindex hikes

**Files:**
- Create: `src/services/hikes.ts`, `src/services/indexing.ts`
- Test: `test/hikes.test.ts`, `test/indexing.test.ts`

**Interfaces:**
- Consumes: `Deps`, `indexTrail`, `laToday`, `Trail`.
- Produces:
  - `class UserError extends Error`
  - `const MAX_HIKES_PER_USER = 50`, `MAX_DESCRIPTION = 2000`
  - `addHikeSchema` (zod object, snake_case tool fields) and `type AddHikeInput = z.infer<typeof addHikeSchema>`
  - `addHike(deps, userId, input: AddHikeInput): Promise<{ id: string; indexState: "indexed" | "failed"; message: string }>`
  - `deleteHike(deps, userId, id: string): Promise<{ id: string; message: string }>`
  - `interface ReindexResult { indexed: number; failed: number; remaining: number }`, `REINDEX_CHUNK = 20`
  - `reindexTrails(deps, opts?: { limit?: number }): Promise<ReindexResult>` (one chunk per call)
  - `seedShared(deps, trails: Trail[]): Promise<ReindexResult>`

- [ ] **Step 1: Write the failing tests `test/hikes.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { MAX_DESCRIPTION, MAX_HIKES_PER_USER, UserError, addHike, addHikeSchema, deleteHike } from "../src/services/hikes";
import type { Deps } from "../src/services/deps";
import { applySchema, clearTrails } from "./helpers/db";
import { FailingEmbedder, HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";
import { makeTrail } from "./helpers/fixtures";

const db = (env as unknown as { DB: D1Database }).DB;
let deps: Deps;
let vectors: InMemoryVectorStore;

const valid = {
  name: "Backyard Loop",
  area: "Altadena",
  trailhead: "End of Maple St",
  route_type: "loop" as const,
  distance_mi: 2.2,
  difficulty: "easy" as const,
  description: "Quiet loop with oak shade.",
};

beforeAll(async () => applySchema(db));
beforeEach(async () => {
  await clearTrails(db);
  vectors = new InMemoryVectorStore();
  deps = { repo: new TrailsRepo(db), embedder: new HashEmbedder(), vectors, now: () => new Date("2026-10-07T20:00:00Z") };
});

describe("addHike", () => {
  it("stores a private hike owned by the caller and indexes it", async () => {
    const res = await addHike(deps, "1", addHikeSchema.parse(valid));
    expect(res.indexState).toBe("indexed");
    const trail = await deps.repo.getVisible(res.id, "1");
    expect(trail).toMatchObject({ owner: "1", status: "open", statusChecked: "2026-10-07", indexState: "indexed" });
    expect(vectors.records.has(res.id)).toBe(true);
    expect(await deps.repo.getVisible(res.id, "2")).toBeNull();
  });
  it("is idempotent: the same name and trailhead updates instead of duplicating", async () => {
    const a = await addHike(deps, "1", addHikeSchema.parse(valid));
    const b = await addHike(deps, "1", addHikeSchema.parse({ ...valid, description: "Updated text." }));
    expect(b.id).toBe(a.id);
    expect(await deps.repo.countOwned("1")).toBe(1);
    expect((await deps.repo.getVisible(a.id, "1"))?.description).toBe("Updated text.");
  });
  it("gives different users different ids for the same hike", async () => {
    const a = await addHike(deps, "1", addHikeSchema.parse(valid));
    const b = await addHike(deps, "2", addHikeSchema.parse(valid));
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeLessThanOrEqual(64);
  });
  it("saves the hike as failed and says indexing is pending when embedding fails", async () => {
    const failing = { ...deps, embedder: new FailingEmbedder() };
    const res = await addHike(failing, "1", addHikeSchema.parse(valid));
    expect(res.indexState).toBe("failed");
    expect(res.message).toMatch(/indexing pending/i);
    expect((await deps.repo.getVisible(res.id, "1"))?.indexState).toBe("failed");
    expect(vectors.records.has(res.id)).toBe(false);
  });
  it("saves the hike as failed when the vector upsert throws", async () => {
    vectors.failNextUpsert();
    const res = await addHike(deps, "1", addHikeSchema.parse(valid));
    expect(res.indexState).toBe("failed");
  });
  it("enforces the per-user cap", async () => {
    for (let i = 0; i < MAX_HIKES_PER_USER; i++) {
      await addHike(deps, "1", addHikeSchema.parse({ ...valid, name: `Hike ${i}` }));
    }
    await expect(addHike(deps, "1", addHikeSchema.parse({ ...valid, name: "One too many" }))).rejects.toThrow(UserError);
    // updating an existing hike at the cap is still allowed
    await expect(addHike(deps, "1", addHikeSchema.parse({ ...valid, name: "Hike 0" }))).resolves.toBeDefined();
  }, 60_000);
  it("cannot be pushed past the cap by concurrent adds", async () => {
    for (let i = 0; i < MAX_HIKES_PER_USER - 1; i++) {
      await addHike(deps, "1", addHikeSchema.parse({ ...valid, name: `Hike ${i}` }));
    }
    const results = await Promise.allSettled([
      addHike(deps, "1", addHikeSchema.parse({ ...valid, name: "Race A" })),
      addHike(deps, "1", addHikeSchema.parse({ ...valid, name: "Race B" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(await deps.repo.countOwned("1")).toBe(MAX_HIKES_PER_USER);
  }, 60_000);
  it("accepts HTML, emoji and exactly 2000 characters; rejects 2001", async () => {
    const weird = addHikeSchema.parse({ ...valid, name: "<b>Café 🌄</b>", description: "x".repeat(MAX_DESCRIPTION) });
    const res = await addHike(deps, "1", weird);
    expect((await deps.repo.getVisible(res.id, "1"))?.name).toBe("<b>Café 🌄</b>");
    expect(() => addHikeSchema.parse({ ...valid, description: "x".repeat(MAX_DESCRIPTION + 1) })).toThrow();
  });
  it("rejects invalid numbers", () => {
    expect(() => addHikeSchema.parse({ ...valid, distance_mi: 0 })).toThrow();
    expect(() => addHikeSchema.parse({ ...valid, distance_mi: -2 })).toThrow();
    expect(() => addHikeSchema.parse({ ...valid, gain_ft: -5 })).toThrow();
    expect(() => addHikeSchema.parse({ ...valid, name: "   " })).toThrow();
  });
});

describe("deleteHike", () => {
  it("deletes the caller's own hike from D1 and the index", async () => {
    const { id } = await addHike(deps, "1", addHikeSchema.parse(valid));
    await deleteHike(deps, "1", id);
    expect(await deps.repo.getVisible(id, "1")).toBeNull();
    expect(vectors.records.has(id)).toBe(false);
  });
  it("answers 'not found' for a seed id, another user's id, and a nonexistent id, deleting nothing", async () => {
    await deps.repo.upsert(makeTrail({ id: "seed:s", owner: "shared" }));
    const theirs = await addHike(deps, "2", addHikeSchema.parse(valid));
    for (const id of ["seed:s", theirs.id, "u:nope"]) {
      await expect(deleteHike(deps, "1", id)).rejects.toThrow(/not found/i);
    }
    expect(await deps.repo.getVisible("seed:s", "1")).not.toBeNull();
    expect(await deps.repo.getVisible(theirs.id, "2")).not.toBeNull();
  });
});
```

`test/indexing.test.ts`:
```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { addHike, addHikeSchema } from "../src/services/hikes";
import { reindexTrails, seedShared } from "../src/services/indexing";
import type { Deps } from "../src/services/deps";
import { applySchema, clearTrails } from "./helpers/db";
import { FailingEmbedder, HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";
import { makeTrail } from "./helpers/fixtures";

const db = (env as unknown as { DB: D1Database }).DB;
let deps: Deps;
let vectors: InMemoryVectorStore;

beforeAll(async () => applySchema(db));
beforeEach(async () => {
  await clearTrails(db);
  vectors = new InMemoryVectorStore();
  deps = { repo: new TrailsRepo(db), embedder: new HashEmbedder(), vectors, now: () => new Date("2026-10-07T20:00:00Z") };
});

describe("reindexTrails", () => {
  it("repairs a failed add without duplicating", async () => {
    vectors.failNextUpsert();
    const input = addHikeSchema.parse({ name: "Retry", area: "A", trailhead: "T", route_type: "loop", distance_mi: 1, difficulty: "easy", description: "d" });
    const first = await addHike(deps, "1", input);
    expect(first.indexState).toBe("failed");
    expect(await reindexTrails(deps)).toEqual({ indexed: 1, failed: 0, remaining: 0 });
    expect((await deps.repo.getVisible(first.id, "1"))?.indexState).toBe("indexed");
    expect(vectors.records.size).toBe(1);
  });
  it("marks the whole chunk failed when embedding fails, and reports what remains", async () => {
    await deps.repo.upsert(makeTrail({ id: "seed:a", name: "A" }));
    await deps.repo.upsert(makeTrail({ id: "seed:b", name: "B" }));
    const res = await reindexTrails({ ...deps, embedder: new FailingEmbedder() });
    expect(res).toEqual({ indexed: 0, failed: 2, remaining: 2 });
  });
  it("works in bounded chunks and reports remaining", async () => {
    for (let i = 0; i < 5; i++) await deps.repo.upsert(makeTrail({ id: `seed:r${i}`, name: `R${i}` }));
    expect(await reindexTrails(deps, { limit: 2 })).toEqual({ indexed: 2, failed: 0, remaining: 3 });
    expect(await reindexTrails(deps, { limit: 10 })).toEqual({ indexed: 3, failed: 0, remaining: 0 });
  });
  it("makes a bounded number of binding calls per chunk", async () => {
    for (let i = 0; i < 20; i++) await deps.repo.upsert(makeTrail({ id: `seed:c${i}`, name: `C${i}` }));
    let embedCalls = 0;
    const counting = { ...deps, embedder: { embed: deps.embedder.embed.bind(deps.embedder), embedMany: async (t: string[]) => { embedCalls++; return deps.embedder.embedMany(t); } } };
    await reindexTrails(counting);
    expect(embedCalls).toBe(1);
  });
});

describe("seedShared", () => {
  it("writes shared trails to D1 and indexes them", async () => {
    const res = await seedShared(deps, [makeTrail({ id: "seed:a", name: "A" }), makeTrail({ id: "seed:b", name: "B" })]);
    expect(res).toEqual({ indexed: 2, failed: 0, remaining: 0 });
    expect(vectors.records.size).toBe(2);
  });
  it("re-seeding updates the row and re-indexes it", async () => {
    await seedShared(deps, [makeTrail({ id: "seed:a", name: "A", description: "old" })]);
    await seedShared(deps, [makeTrail({ id: "seed:a", name: "A", description: "new" })]);
    expect((await deps.repo.getVisible("seed:a", "1"))?.description).toBe("new");
    expect(vectors.records.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/hikes.test.ts test/indexing.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement `src/services/hikes.ts`**

```ts
import { z } from "zod";
import { laToday } from "../domain/closure";
import { SHARED_OWNER, type Trail } from "../domain/types";
import type { Deps } from "./deps";
import { indexTrail } from "./search";

export class UserError extends Error {}

export const MAX_HIKES_PER_USER = 50;
export const MAX_DESCRIPTION = 2000;

export const addHikeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  area: z.string().trim().min(1).max(120),
  trailhead: z.string().trim().min(1).max(200),
  route_type: z.enum(["loop", "out-and-back", "point-to-point", "lollipop"]),
  distance_mi: z.number().positive().max(200),
  gain_ft: z.number().nonnegative().max(20000).optional(),
  difficulty: z.enum(["easy", "moderate", "hard"]),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  description: z.string().trim().min(1).max(MAX_DESCRIPTION),
});
export type AddHikeInput = z.infer<typeof addHikeSchema>;

async function privateHikeId(owner: string, name: string, trailhead: string): Promise<string> {
  const data = new TextEncoder().encode(`${owner}\n${name.toLowerCase()}\n${trailhead.toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `u:${hex.slice(0, 32)}`;
}

export async function addHike(
  deps: Deps,
  userId: string,
  input: AddHikeInput,
): Promise<{ id: string; indexState: "indexed" | "failed"; message: string }> {
  if (userId === SHARED_OWNER) throw new UserError("not signed in");
  const id = await privateHikeId(userId, input.name, input.trailhead);
  const existing = await deps.repo.getVisible(id, userId);

  const trail: Trail = {
    id,
    owner: userId,
    name: input.name,
    area: input.area,
    trailhead: input.trailhead,
    routeType: input.route_type,
    distanceMinMi: input.distance_mi,
    distanceMaxMi: input.distance_mi,
    gainMinFt: input.gain_ft ?? null,
    gainMaxFt: input.gain_ft ?? null,
    difficulty: input.difficulty,
    difficultyNote: null,
    tags: input.tags,
    description: input.description,
    status: "open",
    closedUntil: null,
    statusNote: null,
    statusChecked: laToday(deps.now()),
    sourceUrls: [],
    indexState: "pending",
    indexedAt: null,
  };
  // The cap is enforced inside the same SQL statement as the insert, so concurrent adds cannot exceed it.
  if (!(await deps.repo.upsert(trail, { maxOwned: MAX_HIKES_PER_USER }))) {
    throw new UserError(existing ? "could not save hike" : `hike limit reached (${MAX_HIKES_PER_USER}); delete one first`);
  }

  try {
    await indexTrail(deps, trail);
    await deps.repo.setIndexState(id, "indexed", deps.now());
    return { id, indexState: "indexed", message: "Saved. It may take a few seconds to appear in search." };
  } catch (err) {
    console.error("indexing failed", err instanceof Error ? err.message : "unknown error");
    await deps.repo.setIndexState(id, "failed", deps.now());
    return { id, indexState: "failed", message: "Saved; indexing pending. It will appear in search after the next reindex." };
  }
}

export async function deleteHike(deps: Deps, userId: string, id: string): Promise<{ id: string; message: string }> {
  if (!(await deps.repo.deleteOwned(id, userId))) throw new UserError("hike not found");
  try {
    await deps.vectors.deleteByIds([id]);
  } catch (err) {
    // The D1 row is gone, so search drops the orphan vector id on hydration.
    console.error("vector delete failed", err instanceof Error ? err.message : "unknown error");
  }
  return { id, message: "Deleted." };
}
```

- [ ] **Step 4: Implement `src/services/indexing.ts`**

Workers Free allows 50 subrequests (D1 queries and binding calls) per invocation, so indexing works in bounded chunks: one embedding call, one Vectorize upsert, and one batched state update per chunk of at most 20 rows. Callers repeat until `remaining` is 0 (or stop when `indexed` is 0, which means the remaining rows keep failing).

```ts
import { embeddingText, toVectorMetadata } from "../domain/search-rules";
import type { Trail } from "../domain/types";
import type { Deps } from "./deps";

export const REINDEX_CHUNK = 20;

export interface ReindexResult {
  indexed: number;
  failed: number;
  remaining: number; // rows still not indexed (includes rows that failed)
}

export async function reindexTrails(deps: Deps, opts: { limit?: number } = {}): Promise<ReindexResult> {
  const rows = await deps.repo.listForReindex(opts.limit ?? REINDEX_CHUNK);
  let indexed = 0;
  let failed = 0;
  if (rows.length > 0) {
    const ids = rows.map((t) => t.id);
    try {
      const values = await deps.embedder.embedMany(rows.map(embeddingText));
      await deps.vectors.upsert(rows.map((t, i) => ({ id: t.id, values: values[i]!, metadata: toVectorMetadata(t) })));
      await deps.repo.setIndexStateMany(ids, "indexed", deps.now());
      indexed = ids.length;
    } catch (err) {
      console.error("reindex failed", err instanceof Error ? err.message : "unknown error");
      await deps.repo.setIndexStateMany(ids, "failed", deps.now());
      failed = ids.length;
    }
  }
  return { indexed, failed, remaining: await deps.repo.countUnindexed() };
}

export async function seedShared(deps: Deps, trails: Trail[]): Promise<ReindexResult> {
  await deps.repo.upsertMany(trails.map((t) => ({ ...t, indexState: "pending" as const, indexedAt: null })));
  return reindexTrails(deps);
}
```

Note: `upsertMany` resets seeded rows to `pending`, so re-seeding re-embeds exactly those rows. A `remaining` greater than 0 after `seedShared` means the seed has more than one chunk of rows: call `reindexTrails` again (the `/admin/reindex` route does this).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/hikes.test.ts test/indexing.test.ts` → PASS.

- [ ] **Step 6: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 9: MCP tools and server registration

**Files:**
- Create: `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/deps.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `searchHikes`, `addHike`, `deleteHike`, `addHikeSchema`, `UserError`, `Deps`, `Env`.
- Produces:
  - `interface ToolContext { deps: Deps; userId: string; scopes: string[] }`
  - `type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }`
  - `resolveToolAuth(props: Record<string, unknown> | undefined, authScopes: string[] | undefined): { userId: string; scopes: string[] }`
  - Raw zod shapes: `searchHikesShape`, `addHikeShape` (= `addHikeSchema.shape`), `deleteHikeShape`
  - `searchHikesTool(ctx, args: unknown)`, `addHikeTool(ctx, args: unknown)`, `deleteHikeTool(ctx, args: unknown)` → `Promise<unknown>` payloads
  - `callTool(fn: () => Promise<unknown>): Promise<ToolResult>`
  - `requireScope(scopes: string[], scope: string): void` (throws `UserError`)
  - `createServer(env: Env): McpServer` (in `src/mcp/server.ts`)
  - `makeDeps(env: Env): Deps` (in `src/deps.ts`)

- [ ] **Step 1: Write the failing tests `test/tools.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { addHikeTool, callTool, deleteHikeTool, requireScope, resolveToolAuth, searchHikesTool, type ToolContext } from "../src/mcp/tools";
import { UserError } from "../src/services/hikes";
import { seedShared } from "../src/services/indexing";
import { applySchema, clearTrails } from "./helpers/db";
import { HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";
import { makeTrail } from "./helpers/fixtures";

const db = (env as unknown as { DB: D1Database }).DB;
let ctx: ToolContext;

beforeAll(async () => applySchema(db));
beforeEach(async () => {
  await clearTrails(db);
  const deps = { repo: new TrailsRepo(db), embedder: new HashEmbedder(), vectors: new InMemoryVectorStore(), now: () => new Date("2026-10-07T20:00:00Z") };
  ctx = { deps, userId: "1", scopes: ["mcp:read", "mcp:write"] };
  await seedShared(deps, [
    makeTrail({ id: "seed:falls", name: "Hidden Falls", description: "Shady creek walk to a waterfall.", tags: ["waterfall"] }),
    makeTrail({ id: "seed:eaton", name: "Eaton Canyon Falls", description: "Creek canyon waterfall.", status: "closed", closedUntil: "2027-12-31" }),
  ]);
});

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("search_hikes tool", () => {
  it("returns compact hits without leaking owner ids", async () => {
    const r = await callTool(() => searchHikesTool(ctx, { query: "shady creek waterfall" }));
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(text(r));
    expect(body.results[0]).toMatchObject({ id: "seed:falls", name: "Hidden Falls", source: "shared", status: "available" });
    expect(JSON.stringify(body)).not.toContain('"owner"');
  });
  it("reports closed trails with the reopening date when include_closed is true", async () => {
    const body = JSON.parse(text(await callTool(() => searchHikesTool(ctx, { query: "creek canyon waterfall", include_closed: true }))));
    expect(body.results.find((x: { id: string }) => x.id === "seed:eaton")).toMatchObject({ status: "closed", closed_through: "2027-12-31" });
  });
  it.each([
    [{ query: "" }],
    [{ query: "   " }],
    [{ query: "x".repeat(501) }],
    [{ query: "hike", max_distance: 0 }],
    [{ query: "hike", max_distance: -1 }],
    [{ query: "hike", max_distance: Number.NaN }],
    [{ query: "hike", max_gain: -1 }],
    [{ query: "hike", limit: 26 }],
    [{ query: "hike", difficulty: "extreme" }],
    [{ query: "hike", date: "2026-02-30" }],
    [{ query: "hike", date: "10/07/2026" }],
  ])("rejects invalid input %j with a clear error, not an exception", async (args) => {
    const r = await callTool(() => searchHikesTool(ctx, args));
    expect(r.isError).toBe(true);
    expect(text(r)).toBeTruthy();
  });
});

describe("add_hike / delete_hike tools", () => {
  const args = { name: "Backyard Loop", area: "Altadena", trailhead: "Maple St", route_type: "loop", distance_mi: 2, difficulty: "easy", description: "Quiet oak loop." };
  it("adds then deletes a private hike", async () => {
    const added = JSON.parse(text(await callTool(() => addHikeTool(ctx, args))));
    expect(added.index_state).toBe("indexed");
    const found = JSON.parse(text(await callTool(() => searchHikesTool(ctx, { query: "quiet oak loop" }))));
    expect(found.results.map((x: { id: string }) => x.id)).toContain(added.id);
    const del = await callTool(() => deleteHikeTool(ctx, { trail_id: added.id }));
    expect(del.isError).toBeUndefined();
  });
  it("requires the mcp:write scope and leaves data untouched when refused", async () => {
    const added = JSON.parse(text(await callTool(() => addHikeTool(ctx, args))));
    const readOnly = { ...ctx, scopes: ["mcp:read"] };
    expect((await callTool(() => addHikeTool(readOnly, { ...args, name: "Second" }))).isError).toBe(true);
    const del = await callTool(() => deleteHikeTool(readOnly, { trail_id: added.id }));
    expect(del.isError).toBe(true);
    expect(text(del)).toMatch(/mcp:write/);
    expect(await ctx.deps.repo.getVisible(added.id, "1")).not.toBeNull();
    expect(await ctx.deps.repo.countOwned("1")).toBe(1);
  });
  it("requires mcp:read before touching any data", async () => {
    const r = await callTool(() => searchHikesTool({ ...ctx, scopes: [] }, { query: "waterfall" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/mcp:read/);
  });
  it("turns unexpected errors into a generic message that leaks nothing", async () => {
    const r = await callTool(async () => { throw new Error("secret-token-abc123 database exploded"); });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain("secret-token");
  });
});

describe("resolveToolAuth", () => {
  it("reads the user id from props and prefers authInfo scopes, falling back to props.scopes", () => {
    expect(resolveToolAuth({ userId: "7", scopes: ["mcp:read"] }, ["mcp:read", "mcp:write"])).toEqual({ userId: "7", scopes: ["mcp:read", "mcp:write"] });
    expect(resolveToolAuth({ userId: "7", scopes: ["mcp:read"] }, undefined)).toEqual({ userId: "7", scopes: ["mcp:read"] });
    expect(resolveToolAuth({ userId: "7" }, [])).toEqual({ userId: "7", scopes: [] });
  });
  it("rejects missing or non-string user ids", () => {
    expect(() => resolveToolAuth(undefined, ["mcp:read"])).toThrow(UserError);
    expect(() => resolveToolAuth({ userId: 7 }, ["mcp:read"])).toThrow(UserError);
    expect(() => resolveToolAuth({ userId: "" }, ["mcp:read"])).toThrow(UserError);
  });
});

describe("requireScope", () => {
  it("passes when present and throws UserError when missing", () => {
    expect(() => requireScope(["mcp:write"], "mcp:write")).not.toThrow();
    expect(() => requireScope(["mcp:read"], "mcp:write")).toThrow(UserError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tools.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/mcp/tools.ts`**

```ts
import { z } from "zod";
import type { SearchHit } from "../services/search";
import { searchHikes } from "../services/search";
import { UserError, addHike, addHikeSchema, deleteHike } from "../services/hikes";
import type { Deps } from "../services/deps";
import { SHARED_OWNER } from "../domain/types";

export interface ToolContext {
  deps: Deps;
  userId: string;
  scopes: string[];
}

// A type alias (not an interface) so it is assignable to the SDK's CallToolResult index signature.
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const t = Date.parse(s);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "must be a real calendar date");

export const searchHikesShape = {
  query: z.string().trim().min(1).max(500),
  max_distance: z.number().positive().max(200).optional(),
  max_gain: z.number().nonnegative().max(20000).optional(),
  difficulty: z.enum(["easy", "moderate", "hard"]).optional(),
  include_closed: z.boolean().optional(),
  date: isoDate.optional(),
  limit: z.number().int().min(1).max(25).optional(),
};
export const addHikeShape = addHikeSchema.shape;
export const deleteHikeShape = { trail_id: z.string().min(1).max(64) };

export function requireScope(scopes: string[], scope: string): void {
  if (!scopes.includes(scope)) throw new UserError(`this action needs the ${scope} permission`);
}

/** Combines the verified token props with the SDK's authInfo scopes (props are the fallback). */
export function resolveToolAuth(
  props: Record<string, unknown> | undefined,
  authScopes: string[] | undefined,
): { userId: string; scopes: string[] } {
  const userId = props?.userId;
  if (typeof userId !== "string" || userId === "") throw new UserError("not signed in");
  const propScopes = props?.scopes;
  const fromProps = Array.isArray(propScopes) ? propScopes.filter((x): x is string => typeof x === "string") : [];
  return { userId, scopes: authScopes && authScopes.length > 0 ? authScopes : fromProps };
}

function presentHit(h: SearchHit) {
  const t = h.trail;
  return {
    id: t.id,
    name: t.name,
    area: t.area,
    trailhead: t.trailhead,
    route_type: t.routeType,
    distance_mi: [t.distanceMinMi, t.distanceMaxMi],
    gain_ft: t.gainMinFt === null || t.gainMaxFt === null ? null : [t.gainMinFt, t.gainMaxFt],
    difficulty: t.difficulty,
    difficulty_note: t.difficultyNote,
    tags: t.tags,
    description: t.description,
    source: t.owner === SHARED_OWNER ? "shared" : "private",
    status: h.availability === "excluded" ? "closed" : h.availability,
    closed_through: h.closedThrough,
    status_note: t.statusNote,
    status_checked: t.statusChecked,
    flags: h.flags,
    score: h.score,
  };
}

export async function searchHikesTool(ctx: ToolContext, rawArgs: unknown) {
  requireScope(ctx.scopes, "mcp:read"); // the OAuth provider advertises scopes but does not enforce them
  const a = z.object(searchHikesShape).parse(rawArgs);
  const hits = await searchHikes(ctx.deps, ctx.userId, {
    query: a.query,
    maxDistanceMi: a.max_distance,
    maxGainFt: a.max_gain,
    difficulty: a.difficulty,
    includeClosed: a.include_closed,
    date: a.date,
    limit: a.limit,
  });
  return { count: hits.length, results: hits.map(presentHit) };
}

export async function addHikeTool(ctx: ToolContext, rawArgs: unknown) {
  requireScope(ctx.scopes, "mcp:write");
  const r = await addHike(ctx.deps, ctx.userId, addHikeSchema.parse(rawArgs));
  return { id: r.id, index_state: r.indexState, message: r.message };
}

export async function deleteHikeTool(ctx: ToolContext, rawArgs: unknown) {
  requireScope(ctx.scopes, "mcp:write");
  const a = z.object(deleteHikeShape).parse(rawArgs);
  return deleteHike(ctx.deps, ctx.userId, a.trail_id);
}

export async function callTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    if (err instanceof UserError) return { isError: true, content: [{ type: "text", text: err.message }] };
    if (err instanceof z.ZodError) {
      const msg = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return { isError: true, content: [{ type: "text", text: `invalid input: ${msg}` }] };
    }
    console.error("tool failed", err instanceof Error ? err.name : "unknown");
    return { isError: true, content: [{ type: "text", text: "internal error; please try again" }] };
  }
}
```

- [ ] **Step 4: Implement `src/deps.ts` and `src/mcp/server.ts`**

```ts
// src/deps.ts
import { VectorizeStore } from "./adapters/vectorize";
import { WorkersAiEmbedder } from "./adapters/workers-ai";
import { TrailsRepo } from "./db/trails-repo";
import type { Env } from "./env";
import type { Deps } from "./services/deps";

export function makeDeps(env: Env): Deps {
  return {
    repo: new TrailsRepo(env.DB),
    embedder: new WorkersAiEmbedder(env.AI),
    vectors: new VectorizeStore(env.VECTORIZE),
    now: () => new Date(),
  };
}
```

```ts
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { makeDeps } from "../deps";
import type { Env } from "../env";
import {
  addHikeShape, addHikeTool, callTool, deleteHikeShape, deleteHikeTool, resolveToolAuth, searchHikesShape,
  searchHikesTool, type ToolContext,
} from "./tools";

type CallbackContext = { http?: { authInfo?: { scopes?: string[] } } };

function toolContext(env: Env, context: CallbackContext): ToolContext {
  const auth = resolveToolAuth(getMcpAuthContext()?.props, context.http?.authInfo?.scopes);
  return { deps: makeDeps(env), ...auth };
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "trailmates-mcp", version: "0.1.0" });

  server.registerTool(
    "search_hikes",
    {
      description:
        "Find hikes by meaning, e.g. 'shaded creek walk with a waterfall'. Searches the shared LA-area trails plus the caller's private hikes. Closed trails are hidden unless include_closed is true; a trail named exactly is always returned with its status. Distances and gain are matched on a trail's upper bound.",
      inputSchema: searchHikesShape,
      annotations: { readOnlyHint: true },
    },
    (args, context) => callTool(() => searchHikesTool(toolContext(env, context), args)),
  );

  server.registerTool(
    "add_hike",
    {
      description:
        "Add a private hike visible only to you. Re-adding the same name and trailhead updates it. New hikes may take a few seconds to appear in search.",
      inputSchema: addHikeShape,
    },
    (args, context) => callTool(() => addHikeTool(toolContext(env, context), args)),
  );

  server.registerTool(
    "delete_hike",
    {
      description: "Delete one of your own private hikes by id. Shared trails cannot be deleted.",
      inputSchema: deleteHikeShape,
      annotations: { destructiveHint: true },
    },
    (args, context) => callTool(() => deleteHikeTool(toolContext(env, context), args)),
  );

  return server;
}
```

- [ ] **Step 5: Run to verify pass, then typecheck**

Run: `npx vitest run test/tools.test.ts && npm run typecheck`
Expected: tests PASS. If `tsc` rejects `inputSchema: <raw zod shape>` against the installed `@modelcontextprotocol/server` types, wrap each shape in `z.object(...)` at the `registerTool` call sites (`inputSchema: z.object(searchHikesShape)`) and import `z` from `zod`; handler logic is unchanged. If the callback's second argument type differs, adjust `CallbackContext` to the SDK's type; the behavior (read `authInfo.scopes`) stays.

- [ ] **Step 6: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 10: Retrieval eval

**Files:**
- Create: `src/eval/fixtures.ts`, `src/eval/run.ts`
- Test: `test/eval.test.ts`

**Interfaces:**
- Consumes: `Deps`, `searchHikes`.
- Produces:
  - `interface EvalCase { query: string; relevant: string[]; mustNotInclude?: string[]; date: string }`
  - `EVAL_CASES: EvalCase[]`
  - `runEval(deps: Deps, cases?: EvalCase[]): Promise<EvalReport>` with `EvalReport = { ready: boolean; cases: number; top1: number; hitAt3: number; mrr: number; violations: string[]; perCase: { query: string; rank: number | null; top3: string[] }[] }`

- [ ] **Step 1: Write the failing test `test/eval.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { EVAL_CASES } from "../src/eval/fixtures";
import { runEval } from "../src/eval/run";
import { seedShared } from "../src/services/indexing";
import type { Deps } from "../src/services/deps";
import { applySchema, clearTrails } from "./helpers/db";
import { HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";
import { makeTrail } from "./helpers/fixtures";

const db = (env as unknown as { DB: D1Database }).DB;
const D = "2026-10-07";
let deps: Deps;

beforeAll(async () => applySchema(db));
beforeEach(async () => {
  await clearTrails(db);
  deps = { repo: new TrailsRepo(db), embedder: new HashEmbedder(), vectors: new InMemoryVectorStore(), now: () => new Date("2026-10-07T20:00:00Z") };
  await seedShared(deps, [
    makeTrail({ id: "seed:a", name: "A", description: "shady creek waterfall" }),
    makeTrail({ id: "seed:b", name: "B", description: "exposed summit radio towers" }),
    makeTrail({ id: "seed:c", name: "C", description: "creek waterfall canyon", status: "closed", closedUntil: "2027-12-31" }),
  ]);
});

describe("runEval metrics", () => {
  it("computes top1, hit@3, MRR and closure violations", async () => {
    const report = await runEval(deps, [
      { date: D, query: "shady creek waterfall", relevant: ["seed:a"], mustNotInclude: ["seed:c"] },
      { date: D, query: "radio towers summit", relevant: ["seed:b"] },
      { date: D, query: "waterfall", relevant: ["seed:nonexistent"] },
    ]);
    expect(report.ready).toBe(true);
    expect(report.cases).toBe(3);
    expect(report.top1).toBeCloseTo(2 / 3);
    expect(report.hitAt3).toBeCloseTo(2 / 3);
    expect(report.mrr).toBeCloseTo(2 / 3);
    expect(report.violations).toEqual([]);
  });
  it("reports a violation when a forbidden trail appears", async () => {
    const report = await runEval(deps, [{ date: D, query: "creek waterfall canyon", relevant: ["seed:a"], mustNotInclude: ["seed:a"] }]);
    expect(report.violations.length).toBe(1);
  });
  it("reports not ready when nothing is visible, so an empty index cannot pass", async () => {
    await clearTrails(db);
    const report = await runEval(deps, [{ date: D, query: "waterfall", relevant: ["seed:a"], mustNotInclude: ["seed:c"] }]);
    expect(report.ready).toBe(false);
    expect(report.violations).toEqual([]);
  });
  it("ships at least 10 frozen, dated cases including a closure-aware negative", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(10);
    expect(EVAL_CASES.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date))).toBe(true);
    expect(EVAL_CASES.some((c) => c.mustNotInclude?.some((id) => id.startsWith("seed:eaton")))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/eval.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/eval/fixtures.ts`**

```ts
export interface EvalCase {
  query: string;
  relevant: string[];
  mustNotInclude?: string[];
  date: string; // frozen: results must not drift with today's date
}

const EATON = ["seed:eaton-canyon-nature-center", "seed:eaton-canyon-pinecrest"];

// Frozen: changing a case changes the published results. Add cases, do not edit them.
// All cases are evaluated as of 2026-10-07 so the Eaton closure (through 2027-12-31) is stable.
export const EVAL_CASES: EvalCase[] = [
  { date: "2026-10-07", query: "shaded creek walk with a waterfall", relevant: ["seed:solstice-canyon-malibu", "seed:escondido-falls-malibu", "seed:millard-falls"], mustNotInclude: EATON },
  { date: "2026-10-07", query: "stair workout with city views", relevant: ["seed:culver-city-stairs"] },
  { date: "2026-10-07", query: "easy flat walk near JPL with birdwatching", relevant: ["seed:hahamongna-watershed-loop"] },
  { date: "2026-10-07", query: "long shaded flat hike along the arroyo to a dam", relevant: ["seed:gabrielino-jpl-brown-mountain-dam"] },
  { date: "2026-10-07", query: "classic Griffith Park summit with Hollywood sign views", relevant: ["seed:griffith-fern-dell-mount-hollywood"] },
  { date: "2026-10-07", query: "quick after-work neighborhood hike in Eagle Rock", relevant: ["seed:eagle-rock-canyon-trail"] },
  { date: "2026-10-07", query: "exposed fire road to a peak with radio towers", relevant: ["seed:verdugo-peak-from-la-tuna"] },
  { date: "2026-10-07", query: "helipad panoramic views Griffith back side", relevant: ["seed:griffith-helipad-cedar-grove-loop"] },
  { date: "2026-10-07", query: "steep coastal peak with ocean views in Malibu", relevant: ["seed:mugu-peak-point-mugu", "seed:solstice-canyon-malibu"] },
  { date: "2026-10-07", query: "short foothill loop with creek and lookouts", relevant: ["seed:deukmejian-dunsmore-le-mesnager-loop"] },
  { date: "2026-10-07", query: "Eaton Canyon waterfall hike", relevant: [], mustNotInclude: EATON },
];
```

Note: the last case has no relevant ids, so it only contributes to the violation check; `runEval` must skip rank metrics for cases with an empty `relevant` list (Step 4).

- [ ] **Step 4: Implement `src/eval/run.ts`**

```ts
import type { Deps } from "../services/deps";
import { searchHikes } from "../services/search";
import { EVAL_CASES, type EvalCase } from "./fixtures";

export interface EvalReport {
  ready: boolean; // false when no case returned any result (empty or not-yet-visible index)
  cases: number;
  top1: number;
  hitAt3: number;
  mrr: number;
  violations: string[];
  perCase: { query: string; rank: number | null; top3: string[] }[];
}

const EVAL_USER = "eval-user"; // sees only the shared seed

export async function runEval(deps: Deps, cases: EvalCase[] = EVAL_CASES): Promise<EvalReport> {
  const violations: string[] = [];
  const perCase: EvalReport["perCase"] = [];
  let anyHits = false;
  let scored = 0;
  let top1 = 0;
  let hit3 = 0;
  let rr = 0;

  for (const c of cases) {
    const hits = await searchHikes(deps, EVAL_USER, { query: c.query, date: c.date, limit: 10 });
    const ids = hits.map((h) => h.trail.id);
    if (ids.length > 0) anyHits = true;
    for (const bad of c.mustNotInclude ?? []) {
      if (ids.includes(bad)) violations.push(`"${c.query}" returned forbidden ${bad}`);
    }
    const idx = ids.findIndex((id) => c.relevant.includes(id));
    const rank = idx === -1 ? null : idx + 1;
    perCase.push({ query: c.query, rank, top3: ids.slice(0, 3) });
    if (c.relevant.length === 0) continue;
    scored++;
    if (rank === 1) top1++;
    if (rank !== null && rank <= 3) hit3++;
    if (rank !== null) rr += 1 / rank;
  }
  const n = scored || 1;
  return { ready: anyHits, cases: cases.length, top1: top1 / n, hitAt3: hit3 / n, mrr: rr / n, violations, perCase };
}
```

Careful: in the Step 1 test, "radio towers summit" and the third case's relevant id `seed:nonexistent` are scored cases, so `scored` is 3 there; the expectations (2/3 each) hold because case 1 rank 1, case 2 rank 1, case 3 null.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/eval.test.ts && npm run typecheck && npm test` → PASS.

- [ ] **Step 6: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 11: Authentication, admin routes, and the Worker entry

**Files:**
- Create: `src/auth/github.ts`, `src/auth/consent-page.ts`, `src/auth/handler.ts`, `src/admin.ts`, `src/index.ts`
- Test: `test/github.test.ts`, `test/consent-page.test.ts`, `test/admin.test.ts`

**Interfaces:**
- Consumes: `Env`, `makeDeps`, `createServer`, `normalizeSeed`, `seedShared`, `reindexTrails`, `runEval` from `src/eval/run.ts` (Task 10).
- Produces:
  - `SUPPORTED_SCOPES: string[]`, `chooseScopes(formScopes: string[]): string[]` (always includes `mcp:read`)
  - `s256(verifier: string): Promise<string>`; `githubAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string`; `exchangeGithubCode(p: { clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string }, fetchFn?: typeof fetch): Promise<string>` (returns the access token); `fetchGithubUser(token: string, fetchFn?: typeof fetch): Promise<{ id: number; login: string }>`
  - `renderConsentPage(details: ConsentDescription, handle: string): string`
  - Behavior: a user who unticks write still gets `mcp:read`; a user who declines at GitHub sends the MCP client an `access_denied` redirect; tampered handles/state return 400.
  - `handleAdmin(request: Request, adminToken: string | undefined, actions: AdminActions): Promise<Response>` where `AdminActions = { seed(): Promise<unknown>; reindex(onlyUnindexed: boolean): Promise<unknown>; evalRun(): Promise<unknown> }`
  - `default export` of `src/index.ts`: `{ fetch(request, env, ctx) }`

- [ ] **Step 1: Write the failing tests**

`test/github.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { exchangeGithubCode, fetchGithubUser, githubAuthorizeUrl, s256 } from "../src/auth/github";

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    expect(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("githubAuthorizeUrl", () => {
  it("builds the GitHub authorize URL with state and PKCE and no scopes", () => {
    const u = new URL(githubAuthorizeUrl({ clientId: "cid", redirectUri: "https://x.dev/callback", state: "st", codeChallenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "https://x.dev/callback", state: "st", code_challenge: "ch", code_challenge_method: "S256",
    });
  });
});

describe("exchangeGithubCode / fetchGithubUser", () => {
  it("exchanges a code for a token", async () => {
    let body = "";
    const f = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ access_token: "gho_abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const token = await exchangeGithubCode({ clientId: "c", clientSecret: "s", code: "code1", codeVerifier: "v", redirectUri: "https://x.dev/callback" }, f);
    expect(token).toBe("gho_abc");
    expect(body).toContain("code=code1");
    expect(body).toContain("code_verifier=v");
  });
  it("throws without echoing secrets when GitHub returns an error", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeGithubCode({ clientId: "c", clientSecret: "TOPSECRET", code: "x", codeVerifier: "v", redirectUri: "r" }, f)).rejects.toThrow(/github/i);
    await expect(exchangeGithubCode({ clientId: "c", clientSecret: "TOPSECRET", code: "x", codeVerifier: "v", redirectUri: "r" }, f)).rejects.not.toThrow(/TOPSECRET/);
  });
  it("reads the numeric user id", async () => {
    const f = (async () => new Response(JSON.stringify({ id: 4242, login: "octo" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchGithubUser("tok", f)).toEqual({ id: 4242, login: "octo" });
  });
  it("rejects a user response without a numeric id", async () => {
    const f = (async () => new Response(JSON.stringify({ login: "octo" }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchGithubUser("tok", f)).rejects.toThrow();
  });
});
```

`test/consent-page.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SUPPORTED_SCOPES, chooseScopes, renderConsentPage } from "../src/auth/consent-page";

const details = {
  clientName: '<script>alert("x")</script>',
  clientDomain: null,
  redirectHost: "localhost",
  redirectIsLoopback: true,
  scope: ["mcp:read", 'mcp:"write"'],
} as never;

describe("renderConsentPage", () => {
  it("escapes everything that came from the client", () => {
    const html = renderConsentPage(details, 'h"andle');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).not.toContain('value="h"andle"');
  });
  it("shows the redirect host, a loopback warning, and approve/deny buttons", () => {
    const html = renderConsentPage(details, "h");
    expect(html).toContain("localhost");
    expect(html).toMatch(/computer/i);
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
  });
  it("always sends mcp:read and offers mcp:write as a checked option", () => {
    const html = renderConsentPage(details, "h");
    expect(html).toContain('<input type="hidden" name="scope" value="mcp:read">');
    expect(html).toMatch(/<input type="checkbox" name="scope" value="mcp:write" checked>/);
  });
});

describe("chooseScopes", () => {
  it("always includes mcp:read, keeps supported scopes once, and drops unknown ones", () => {
    expect(chooseScopes([])).toEqual(["mcp:read"]);
    expect(chooseScopes(["mcp:write", "admin", "mcp:write"]).sort()).toEqual(["mcp:read", "mcp:write"]);
  });
  it("supports exactly read and write", () => {
    expect(SUPPORTED_SCOPES).toEqual(["mcp:read", "mcp:write"]);
  });
});
```

`test/admin.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";

const calls: string[] = [];
const actions = {
  seed: async () => { calls.push("seed"); return { ok: 1 }; },
  reindex: async (only: boolean) => { calls.push(`reindex:${only}`); return { ok: 2 }; },
  evalRun: async () => { calls.push("eval"); return { ok: 3 }; },
};
const req = (path: string, token?: string, method = "POST") =>
  new Request(`https://x.dev${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("handleAdmin", () => {
  it("is disabled (404) when no ADMIN_TOKEN is configured", async () => {
    expect((await handleAdmin(req("/admin/seed", "anything"), undefined, actions)).status).toBe(404);
  });
  it("rejects a missing or wrong token with 401 and runs nothing", async () => {
    calls.length = 0;
    expect((await handleAdmin(req("/admin/seed"), "s3cret", actions)).status).toBe(401);
    expect((await handleAdmin(req("/admin/seed", "wrong"), "s3cret", actions)).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("runs the requested action with the right token, POST only", async () => {
    calls.length = 0;
    expect((await handleAdmin(req("/admin/seed", "s3cret"), "s3cret", actions)).status).toBe(200);
    expect((await handleAdmin(req("/admin/reindex?all=1", "s3cret"), "s3cret", actions)).status).toBe(200);
    expect((await handleAdmin(req("/admin/eval", "s3cret"), "s3cret", actions)).status).toBe(200);
    expect(calls).toEqual(["seed", "reindex:false", "eval"]);
    expect((await handleAdmin(req("/admin/seed", "s3cret", "GET"), "s3cret", actions)).status).toBe(405);
    expect((await handleAdmin(req("/admin/nope", "s3cret"), "s3cret", actions)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/github.test.ts test/consent-page.test.ts test/admin.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement `src/auth/github.ts`**

```ts
function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function githubAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeGithubCode(
  p: { clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code: p.code,
      code_verifier: p.codeVerifier,
      redirect_uri: p.redirectUri,
    }).toString(),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`GitHub token exchange failed: ${json.error ?? res.status}`);
  return json.access_token;
}

export async function fetchGithubUser(token: string, fetchFn: typeof fetch = fetch): Promise<{ id: number; login: string }> {
  const res = await fetchFn("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "trailmates-mcp" },
  });
  const json = (await res.json()) as { id?: unknown; login?: unknown };
  if (!res.ok || typeof json.id !== "number" || typeof json.login !== "string") {
    throw new Error("GitHub user lookup failed");
  }
  return { id: json.id, login: json.login };
}
```

- [ ] **Step 4: Implement `src/auth/consent-page.ts`**

The consent page always grants `mcp:read` (a hidden field) and offers `mcp:write` as a checked option, whatever the client asked for; the server, not the client, decides what can be offered. `chooseScopes` re-validates the submitted form.

```ts
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const SUPPORTED_SCOPES = ["mcp:read", "mcp:write"];

/** Always includes mcp:read; keeps only supported scopes from the form. */
export function chooseScopes(formScopes: string[]): string[] {
  return [...new Set(["mcp:read", ...formScopes.filter((s) => SUPPORTED_SCOPES.includes(s))])];
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const requested = details.scope.map(escape).join(", ") || "none";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style>
<h1>Allow ${name} to use Trailmates?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>The app asked for: ${requested}</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <input type="hidden" name="scope" value="mcp:read">
  <p>Search trails and see your private hikes (always included).</p>
  <p><label><input type="checkbox" name="scope" value="mcp:write" checked> Add and delete your private hikes</label></p>
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}
```

- [ ] **Step 5: Implement `src/admin.ts`**

```ts
export interface AdminActions {
  seed(): Promise<unknown>;
  reindex(onlyUnindexed: boolean): Promise<unknown>;
  evalRun(): Promise<unknown>;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleAdmin(request: Request, adminToken: string | undefined, actions: AdminActions): Promise<Response> {
  if (!adminToken) return new Response("Not found", { status: 404 });
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (!timingSafeEqual(provided, adminToken)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  const known = ["/admin/seed", "/admin/reindex", "/admin/eval"];
  if (!known.includes(url.pathname)) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (url.pathname === "/admin/seed") return json(await actions.seed());
  if (url.pathname === "/admin/reindex") return json(await actions.reindex(!url.searchParams.has("all")));
  return json(await actions.evalRun());
}
```

- [ ] **Step 6: Implement `src/auth/handler.ts` and `src/index.ts`**

`src/auth/handler.ts`:
```ts
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import seedJson from "../../data/trails.seed.json";
import { handleAdmin } from "../admin";
import { makeDeps } from "../deps";
import { normalizeSeed } from "../domain/seed";
import type { Env } from "../env";
import { runEval } from "../eval/run";
import { reindexTrails, seedShared } from "../services/indexing";
import { chooseScopes, renderConsentPage } from "./consent-page";
import { exchangeGithubCode, fetchGithubUser, githubAuthorizeUrl, s256 } from "./github";

const html = (body: string, headers?: Headers) => {
  const h = new Headers(headers); // keeps the provider's binding cookie, frame-ancestors and no-cache headers
  h.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status: 200, headers: h });
};

/** Tampered or expired handles/state throw AuthorizationError: show a 400, not a 500. */
async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthorizationError) return new Response(`Authorization error: ${err.message}`, { status: 400 });
    throw err;
  }
}

async function authorizeGet(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return html(renderConsentPage(details, consent.handle), consent.headers);
}

async function authorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: chooseScopes(form.getAll("scope").map(String)) });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  headers.set(
    "Location",
    githubAuthorizeUrl({
      clientId: env.GITHUB_CLIENT_ID,
      redirectUri: `${env.PUBLIC_BASE_URL}/callback`,
      state,
      codeChallenge: await s256(verifier),
    }),
  );
  return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers: clear } = await oauth.finishUpstream<{ verifier: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    // The user declined at GitHub (or it failed): tell the MCP client with a standard OAuth error redirect.
    const back = new URL(original.redirectUri);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "GitHub sign-in was not completed");
    if (original.state) back.searchParams.set("state", original.state);
    clear.set("Location", back.toString());
    return new Response(null, { status: 302, headers: clear });
  }
  const token = await exchangeGithubCode({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code,
    codeVerifier: data.verifier,
    redirectUri: `${env.PUBLIC_BASE_URL}/callback`,
  });
  const user = await fetchGithubUser(token); // the GitHub token is used once here and never stored
  const userId = String(user.id);
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId,
    metadata: {},
    scope: original.scope,
    props: { userId, scopes: original.scope },
  });
  clear.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: clear });
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") return guarded(() => authorizeGet(request, env));
    if (url.pathname === "/authorize" && request.method === "POST") return guarded(() => authorizePost(request, env));
    if (url.pathname === "/callback" && request.method === "GET") return guarded(() => callback(request, env));
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname.startsWith("/admin/")) {
      const deps = makeDeps(env);
      return handleAdmin(request, env.ADMIN_TOKEN, {
        seed: () => seedShared(deps, normalizeSeed(seedJson)),
        reindex: async (onlyUnindexed) => {
          if (!onlyUnindexed) await deps.repo.markAllPending(); // ?all=1 re-embeds everything, 20 rows per call
          return reindexTrails(deps);
        },
        evalRun: () => runEval(deps),
      });
    }
    if (url.pathname === "/") return new Response("Trailmates MCP server. Connect an MCP client to /mcp.");
    return new Response("Not found", { status: 404 });
  },
};
```

`src/index.ts`:
```ts
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { SUPPORTED_SCOPES } from "./auth/consent-page";
import { authHandler } from "./auth/handler";
import type { Env } from "./env";
import { createServer } from "./mcp/server";

const mcpApi = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};

let provider: OAuthProvider<Env> | undefined;
function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApi,
    defaultHandler: authHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: SUPPORTED_SCOPES,
    requiredScopes: ["mcp:read"],
    resourceMetadata: {
      resource: `${env.PUBLIC_BASE_URL}/mcp`,
      authorization_servers: [env.PUBLIC_BASE_URL],
    },
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: Run unit tests**

Run: `npx vitest run test/github.test.ts test/consent-page.test.ts test/admin.test.ts` → PASS (these do not import the Worker entry).

- [ ] **Step 8: Typecheck against the installed OAuth provider**

Run: `npm run typecheck`.
Also confirm `AuthRequest` has `redirectUri`, `state` and `scope` fields (used in the decline path). If `tsc` reports different export or method names from `@cloudflare/workers-oauth-provider` (`AuthorizationError`, `ConsentDescription`, `describeConsent`, `beginConsent`, `approveConsent`, `denyConsent`, `beginUpstream`, `finishUpstream`, `completeAuthorization`, `OAuthHelpers`), read `node_modules/@cloudflare/workers-oauth-provider/docs/upstream-sign-in.md` and `consent-page.md` and align the calls to the installed v1 API; the flow (consent, then upstream redirect, then callback, then completeAuthorization with `props: { userId }`) must not change.

- [ ] **Step 9: Checkpoint**

`npm run typecheck && npm test` → pass.

---

### Task 12: Provision, deploy, and verify live

**Files:**
- Modify: `wrangler.jsonc` (real ids and URL)
- Create: `docs/eval-results.md`

**Interfaces:**
- Consumes: the whole Worker, `/admin/seed`, `/admin/eval`.
- Produces: a deployed server, recorded eval results.

- [ ] **Step 1: Provision Cloudflare resources (requires the repository owner)**

These steps create cloud resources and secrets. Ask the owner to run `! npx wrangler login` first (interactive). Then run, in order, and record each printed id:

```bash
# from the repository root
npx wrangler d1 create trailmates                       # copy database_id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV               # copy id into wrangler.jsonc
npx wrangler vectorize create trailmates --dimensions=768 --metric=cosine
# Metadata indexes MUST exist before any vector is upserted:
npx wrangler vectorize create-metadata-index trailmates --property-name=owner --type=string
npx wrangler vectorize create-metadata-index trailmates --property-name=status --type=string
npx wrangler vectorize create-metadata-index trailmates --property-name=difficulty_rank --type=number
npx wrangler vectorize create-metadata-index trailmates --property-name=distance_max_mi --type=number
npx wrangler vectorize create-metadata-index trailmates --property-name=gain_max_ft --type=number
npx wrangler vectorize list-metadata-index trailmates   # expect the 5 indexes
npx wrangler d1 migrations apply trailmates --remote
```

Edit `wrangler.jsonc`: set the real `database_id` and KV `id`. Set `PUBLIC_BASE_URL` to the Worker's URL (`https://trailmates-mcp.<account-subdomain>.workers.dev`; the subdomain is printed by the first deploy, so deploy once, then fix the var and redeploy).

- [ ] **Step 2: Create the GitHub OAuth app (manual, owner only)**

At https://github.com/settings/developers create an OAuth App (or one under the `tensorgroup` org): Homepage URL = `PUBLIC_BASE_URL`, Authorization callback URL = `PUBLIC_BASE_URL/callback`. Then set secrets (each command prompts for the value; never paste secrets into chat or commit them):

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN        # a long random string
```

- [ ] **Step 3: Deploy, seed, and eval**

```bash
npx wrangler deploy
export PUBLIC_BASE_URL="https://trailmates-mcp.<account-subdomain>.workers.dev"   # the URL wrangler deploy printed
read -rs ADMIN_TOKEN && export ADMIN_TOKEN    # paste the same value you stored with `wrangler secret put ADMIN_TOKEN`
curl -s "$PUBLIC_BASE_URL/healthz"                                   # ok
curl -s "$PUBLIC_BASE_URL/.well-known/oauth-protected-resource"       # its "resource" must equal $PUBLIC_BASE_URL/mcp
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$PUBLIC_BASE_URL/mcp"   # expect 401 (sign-in required)
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_BASE_URL/admin/seed"      # {"indexed":18,"failed":0,"remaining":0}
# Vectorize upserts are asynchronous: poll until the eval reports ready (up to ~2 minutes)
for i in $(seq 1 12); do
  curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_BASE_URL/admin/eval" > eval-output.json
  grep -q '"ready":true' eval-output.json && break
  sleep 10
done
cat eval-output.json
```

Expected: seed reports 18 indexed, 0 failed, 0 remaining. If `remaining` is greater than 0, run `curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_BASE_URL/admin/reindex"` until it reaches 0 (stop if `indexed` is 0: those rows keep failing; check `npx wrangler tail`). The eval must come back with `"ready":true` and `"violations":[]`. If it never becomes ready, the index is empty or not yet visible: stop and debug indexing (`npx wrangler vectorize info trailmates`) instead of recording numbers. If any Eaton id appears in `violations`, the closure filter is broken: stop and debug. Also confirm the consent page sends anti-framing headers: open `$PUBLIC_BASE_URL/authorize` through the real client flow once and check with browser dev tools that the response has `X-Frame-Options: DENY`.

- [ ] **Step 4: Record results**

Write `docs/eval-results.md` from `eval-output.json`: the date, the model (`@cf/baai/bge-base-en-v1.5`), top-1, hit@3, MRR, and a table of `perCase` (query, rank, top 3). Do not tune the fixtures to improve the numbers; if a case ranks badly, record it and note a possible cause (description wording, embedding text).

- [ ] **Step 5: Live end-to-end check (owner)**

In Claude Code: `claude mcp add --transport http trailmates <PUBLIC_BASE_URL>/mcp`, then complete the browser sign-in (consent page, then GitHub). Verify: (a) `search_hikes` "shaded creek walk with a waterfall" returns Solstice/Escondido and not Eaton; (b) `search_hikes` with `include_closed: true` and "Eaton Canyon waterfall" shows Eaton closed until 2027-12-31; (c) `add_hike` then `search_hikes` finds it; (d) a **different GitHub account** (a second client registration with the same account shares the same owner id and is expected to see the hike) cannot see the first account's private hike; (d2) unticking "Add and delete your private hikes" on the consent page yields a token that can search but gets a clear permission error from `add_hike`, while the default sign-in can add and delete; (e) `delete_hike` removes it. Note the outcome of each in `docs/eval-results.md` under "Manual verification".

- [ ] **Step 6: Checkpoint**

`npm run typecheck && npm test` → pass; `git status` lists the new files and the edited `wrangler.jsonc`. Confirm `.dev.vars` and `eval-output.json` contain no secrets before anything is committed.

---

### Task 13: CI, README, and release polish

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `docs/demo.md` (script and link for the recorded demo)
- Modify: `.gitignore` (add `eval-output.json`)

**Interfaces:**
- Consumes: everything above. Produces: the public-facing docs.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Add `eval-output.json` to `.gitignore`** (append the line).

- [ ] **Step 3: Write `README.md`**

Sections, in this order, with real content (no placeholders):
1. **What it is**: one paragraph; the three tools (`search_hikes`, `add_hike`, `delete_hike`); the 18-trail LA-area shared seed; private per-user hikes behind GitHub sign-in.
2. **Try it**: the `claude mcp add --transport http trailmates <url>/mcp` command (use the real deployed URL once the repository owner confirms it is public), three example prompts including one that shows closure handling ("what waterfalls are open to hike this weekend?"), and a link to the recorded demo (Step 4) for visitors who have not signed in. All of `/mcp` requires GitHub sign-in; say so plainly.
3. **How it works**: the architecture diagram from the spec (copy the ASCII diagram), plus a short description of the request path and of why D1 is the authorization boundary and Vectorize is only an index.
4. **Why Vectorize instead of pgvector**: a table comparing cost/setup/ops (no database server, free tier, Worker binding), metadata filtering limits (10 indexes, 64-byte string prefix, 2 KiB filter, `topK` 100), consistency (asynchronous upserts, so D1 is the source of truth and `reindex` rebuilds the index; Vectorize can list ids, but not rows with their metadata for authorization), and what would change for pgvector (swap `VectorStore` adapter; `<=>` cosine operator and SQL `WHERE` filters replace metadata indexes; Hyperdrive for connections). State plainly that the `VectorStore` port makes the backend swappable.
5. **Closures**: the truth table from the spec (copy it) and the Eaton example.
6. **Retrieval quality**: the table of results from `docs/eval-results.md`, with the model and date, and a note that fixtures are frozen.
7. **Security model**: owner from token only; D1 re-check on every read; consent page per client; no tokens logged; per-user caps.
8. **Deploy your own**: the exact provisioning commands from Task 12 Steps 1–3, in order, with the warning that metadata indexes must be created before seeding, and including the `export PUBLIC_BASE_URL=...` and `read -rs ADMIN_TOKEN` lines so the curl commands work as written.
9. **Development**: `npm install`, `npm test`, `npm run typecheck`; note that Vectorize and Workers AI are faked in unit tests and the live check is `POST /admin/eval`.
10. **Roadmap**: `plan_outing`, `commit_to_hike`, `check_in`, coordinates from OpenStreetMap, more cities.
11. **License**: MIT.

- [ ] **Step 4: Record the demo (owner)**

Record a 60–90 second screen capture of: signing in (consent page, then GitHub), a `search_hikes` that shows Eaton hidden by default, the same search with `include_closed` showing Eaton closed through 2027-12-31, then `add_hike`, finding it, and `delete_hike`. Put the capture or its link in `docs/demo.md` along with the prompts used, and link it from the README "Try it" section. Do not show tokens or the consent page's handle.

- [ ] **Step 5: Verify the docs against reality**

Run every command in the README "Deploy your own" and "Development" sections against a clean clone path where possible (`npm ci && npm run typecheck && npm test` must pass). Fix any command that does not work as written.

- [ ] **Step 6: Checkpoint**

`npm run typecheck && npm test` → pass. `git status` shows the repo ready for the owner to review and commit. Do not commit or push; tell the owner the repo is private and give the one-line command to make it public once they are ready: `gh repo edit tensorgroup/trailmates-mcp --visibility public --accept-visibility-change-consequences`.

---

## Self-Review

**Spec coverage:** Architecture (`createMcpHandler`, KV, no Durable Objects, per-client consent page, resource metadata check): Tasks 9, 11, 12. Data model (derived private ids, numeric owner, `status_note`, `index_state`, `source_urls`, nullable gain, difficulty enum): Tasks 2, 4, 5. Tools `search_hikes`, `add_hike`, `delete_hike`: Tasks 7–9. Filter semantics: Task 3. Closure truth table, LA timezone, `closed_through`: Task 2. Security (scoped D1, token-derived owner, scope checks, caps, no token logging, consent scopes): Tasks 5, 8, 9, 11. Indexing failure, idempotent repair, subrequest-safe chunked indexing: Tasks 5, 6, 8. Testing (fakes, isolation, indexing failure, eval with negatives, MRR, frozen dates, readiness): Tasks 6–8, 10, 12. Deploy guide, CI, README with the pgvector tradeoff, eval results, demo, MCP-client walkthrough: Tasks 12–13. Milestone-3 tools (`plan_outing`, `commit_to_hike`, `check_in`, `commitments`) are intentionally excluded per the approved scope cut. Left to the owner: rewriting descriptions in their own voice, naming the Griffith back-side road, Millard status, OSM coordinates, recording the demo.

**Spec deviations (spec updated to match):** private hike ids are derived (`u:` + SHA-256 prefix) so retries are idempotent; the live eval waits for index readiness (`ready: true`) instead of comparing Vectorize mutation ids; the field is `closed_through` (the last closed day, inclusive) rather than a reopening date.

**Placeholder scan:** the only deliberate fill-ins are resource ids and the account subdomain in `wrangler.jsonc` and the deploy commands (produced by Task 12), and one source URL for Mugu Peak (Task 4 says how to find it).

**Type consistency:** `Trail`, `Deps`, `Embedder` (`embed`, `embedMany`), `SearchInput`/`SearchHit`, `ToolContext`/`ToolResult`, `AddHikeInput`, `UserError`, `ReindexResult`, `AdminActions`, `EvalCase`/`EvalReport` are defined once and referenced by the same names later. Tool arguments are snake_case at the MCP boundary and mapped to camelCase in `searchHikesTool`; `ClosureResult.closedThrough` surfaces as `closed_through`.

**Review Focus coverage:** items 1 and 5 → Task 9 (invalid inputs) and Task 2 (boundary day); 2, 3, 7 → Task 8; 4 → Task 7; 6 → Task 5; 8 → Tasks 9 and 11; 9 → Tasks 5 and 8.
