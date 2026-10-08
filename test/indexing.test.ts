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
