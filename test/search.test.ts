import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { indexTrail, searchHikes } from "../src/services/search";
import type { Deps } from "../src/services/deps";
import type { Trail } from "../src/domain/types";
import { embeddingText, toVectorMetadata } from "../src/domain/search-rules";
import { applySchema, clearTrails } from "./helpers/db";
import { FailingEmbedder, HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";
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
  it("uses a precomputed queryVector without calling the embedder", async () => {
    const queryVector = await new HashEmbedder().embed("shady creek waterfall");
    const { hits } = await searchHikes({ ...deps, embedder: new FailingEmbedder() }, "42", { query: "shady creek waterfall", queryVector });
    expect(hits[0]?.trail.id).toBe("seed:falls");
  });
  it("ranks by meaning and hides closed trails by default", async () => {
    const { hits } = await searchHikes(deps, "42", { query: "shady creek waterfall" });
    expect(hits[0]?.trail.id).toBe("seed:falls");
    expect(hits.some((h) => h.trail.id === "seed:eaton")).toBe(false);
  });
  it("returns closed trails with their reopening date when include_closed is set", async () => {
    const { hits } = await searchHikes(deps, "42", { query: "creek canyon waterfall", includeClosed: true });
    const eaton = hits.find((h) => h.trail.id === "seed:eaton");
    expect(eaton).toMatchObject({ availability: "excluded", closedThrough: "2027-12-31" });
  });
  it("always returns a trail searched by exact name, with its status", async () => {
    const { hits } = await searchHikes(deps, "42", { query: "Eaton Canyon Falls" });
    expect(hits[0]?.trail.id).toBe("seed:eaton");
    expect(hits[0]?.availability).toBe("excluded");
    expect(hits[0]?.flags.join(" ")).toMatch(/exact name match/);
  });
  it("applies the date parameter to closures (the day after closed_until is verify)", async () => {
    const { hits } = await searchHikes(deps, "42", { query: "creek canyon waterfall", date: "2028-01-01" });
    expect(hits.find((h) => h.trail.id === "seed:eaton")?.availability).toBe("verify");
  });
  it("matches distance on the upper bound", async () => {
    const { hits } = await searchHikes(deps, "42", { query: "hike", maxDistanceMi: 3 });
    expect(hits.map((h) => h.trail.id)).not.toContain("seed:summit");
  });
  it("shows a user their own private hikes but never another user's", async () => {
    await add(makeTrail({ id: "u:mine", owner: "1", name: "Secret Spot", description: "Private hidden waterfall.", tags: ["waterfall"] }));
    const { hits: mine } = await searchHikes(deps, "1", { query: "private hidden waterfall" });
    const { hits: theirs } = await searchHikes(deps, "2", { query: "private hidden waterfall" });
    expect(mine.map((h) => h.trail.id)).toContain("u:mine");
    expect(theirs.map((h) => h.trail.id)).not.toContain("u:mine");
  });
  it("drops stale vector ids (missing from D1) and injected foreign vectors without crashing", async () => {
    const v = await deps.embedder.embed("private hidden waterfall");
    vectors.injectRaw("u:ghost", v, toVectorMetadata(makeTrail({ id: "u:ghost", owner: "1" }))); // not in D1
    await deps.repo.upsert(makeTrail({ id: "u:foreign", owner: "9", name: "Foreign", description: "private hidden waterfall" }));
    vectors.injectRaw("u:foreign", v, { ...toVectorMetadata(makeTrail({ owner: "shared" })), owner: "shared" }); // lies about its owner
    const ids = (await searchHikes(deps, "1", { query: "private hidden waterfall" })).hits.map((h) => h.trail.id);
    expect(ids).not.toContain("u:ghost");
    expect(ids).not.toContain("u:foreign"); // D1 hydration re-checks ownership
  });
  it("respects limit", async () => {
    expect((await searchHikes(deps, "42", { query: "hike", limit: 1 })).hits.length).toBe(1);
  });
  it("returns at most 10 results by default", async () => {
    for (let i = 0; i < 12; i++) {
      await add(makeTrail({ id: `seed:bulk${i}`, name: `Bulk ${i}`, description: "common bulk words" }));
    }
    expect((await searchHikes(deps, "42", { query: "common bulk words" })).hits.length).toBe(10);
  });
  it("flags, but still returns, an exact-name match that falls outside the filters", async () => {
    await add(makeTrail({ id: "seed:long", name: "Long Loop", distanceMinMi: 2.8, distanceMaxMi: 3.5, description: "A long loop." }));
    const { hits } = await searchHikes(deps, "42", { query: "Long Loop", maxDistanceMi: 3 });
    expect(hits[0]?.trail.id).toBe("seed:long");
    expect(hits[0]?.flags).toContain("outside your filters");
  });
});

describe("searchHikes hiddenClosed", () => {
  it("counts candidates hidden only because they are closed", async () => {
    const r = await searchHikes(deps, "42", { query: "creek canyon waterfall" });
    expect(r.hits.map((h) => h.trail.id)).not.toContain("seed:eaton");
    expect(r.hiddenClosed).toBe(1);
  });
  it("is 0 when include_closed is set, because nothing is hidden", async () => {
    const r = await searchHikes(deps, "42", { query: "creek canyon waterfall", includeClosed: true });
    expect(r.hits.map((h) => h.trail.id)).toContain("seed:eaton");
    expect(r.hiddenClosed).toBe(0);
  });
  it("does not count a closed trail that is returned as an exact-name match", async () => {
    const r = await searchHikes(deps, "42", { query: "Eaton Canyon Falls" });
    expect(r.hits[0]?.trail.id).toBe("seed:eaton");
    expect(r.hiddenClosed).toBe(0);
  });
  it("does not count closed trails dropped by distance or difficulty constraints", async () => {
    // The vector metadata claims a short easy trail, so only the D1 re-check drops it.
    const long = makeTrail({ id: "seed:longclosed", name: "Long Closed", description: "Creek canyon waterfall hike.", status: "closed", closedUntil: "2027-12-31", distanceMinMi: 9, distanceMaxMi: 10, difficulty: "hard" });
    await deps.repo.upsert(long);
    vectors.injectRaw("seed:longclosed", await deps.embedder.embed(embeddingText(long)), toVectorMetadata(makeTrail({ id: "seed:longclosed" })));
    expect((await searchHikes(deps, "42", { query: "creek canyon waterfall", maxDistanceMi: 3 })).hiddenClosed).toBe(1);
    expect((await searchHikes(deps, "42", { query: "creek canyon waterfall", difficulty: "moderate" })).hiddenClosed).toBe(1);
    expect((await searchHikes(deps, "42", { query: "creek canyon waterfall" })).hiddenClosed).toBe(2);
  });
  it("never counts another user's private closed trails", async () => {
    await add(makeTrail({ id: "u:closed", owner: "1", name: "My Closed Falls", description: "Creek canyon waterfall hike.", status: "closed", closedUntil: "2027-12-31" }));
    expect((await searchHikes(deps, "1", { query: "creek canyon waterfall" })).hiddenClosed).toBe(2);
    expect((await searchHikes(deps, "2", { query: "creek canyon waterfall" })).hiddenClosed).toBe(1);
    // Even a vector that lies about its owner cannot leak into the count: D1 hydration drops it.
    await deps.repo.upsert(makeTrail({ id: "u:foreignclosed", owner: "9", name: "Foreign Closed", status: "closed", closedUntil: "2027-12-31" }));
    vectors.injectRaw("u:foreignclosed", await deps.embedder.embed("creek canyon waterfall"), toVectorMetadata(makeTrail({ owner: "shared" })));
    expect((await searchHikes(deps, "2", { query: "creek canyon waterfall" })).hiddenClosed).toBe(1);
  });
});

describe("searchHikes hiddenClosed only counts closed trails that would have made the results", () => {
  const unit = (i: number, j?: number, wj = 0) => {
    const v = new Array<number>(256).fill(0);
    v[i] = j === undefined ? 1 : Math.sqrt(1 - wj * wj);
    if (j !== undefined) v[j] = wj;
    return v;
  };
  /** Two trails with hand-made vectors: `top` scores 1.0 against the query, `second` scores 0.8. */
  async function twoRanked(closedId: "top" | "second") {
    await clearTrails(db);
    vectors = new InMemoryVectorStore();
    deps = { ...deps, vectors };
    for (const [id, v] of [["top", unit(0)], ["second", unit(0, 1, 0.6)]] as const) {
      const t = makeTrail({ id: `seed:${id}`, name: `Trail ${id}`, ...(id === closedId ? { status: "closed" as const, closedUntil: "2027-12-31" } : {}) });
      await deps.repo.upsert(t);
      vectors.injectRaw(t.id, v, toVectorMetadata(t));
    }
  }
  it("is 0 for an unrelated query when more than `limit` open trails outrank the closed one", async () => {
    for (let i = 0; i < 12; i++) await add(makeTrail({ id: `seed:bulk${i}`, name: `Bulk ${i}`, description: "common bulk words" }));
    const r = await searchHikes(deps, "42", { query: "common bulk words" });
    expect(r.hits).toHaveLength(10);
    expect(r.hiddenClosed).toBe(0);
  });
  it("counts a closed trail ranked inside the limit", async () => {
    expect((await searchHikes(deps, "42", { query: "creek canyon waterfall" })).hiddenClosed).toBe(1);
  });
  it("with limit 1, counts a closed trail ranked 1st but not one ranked 2nd", async () => {
    await twoRanked("top");
    const first = await searchHikes(deps, "42", { query: "anything", queryVector: unit(0), limit: 1 });
    expect(first.hits.map((h) => h.trail.id)).toEqual(["seed:second"]); // the open runner-up fills the slot
    expect(first.hiddenClosed).toBe(1);
    await twoRanked("second");
    const second = await searchHikes(deps, "42", { query: "anything", queryVector: unit(0), limit: 1 });
    expect(second.hits.map((h) => h.trail.id)).toEqual(["seed:top"]);
    expect(second.hiddenClosed).toBe(0);
  });
  it("counts the 2nd-ranked closed trail once the limit makes room for it", async () => {
    await twoRanked("second");
    expect((await searchHikes(deps, "42", { query: "anything", queryVector: unit(0), limit: 2 })).hiddenClosed).toBe(1);
  });
  it("does not let trails dropped by constraints take up a position", async () => {
    // A long open trail ranked first is dropped by maxDistance, so the closed one is position 1 of 1.
    await twoRanked("second");
    await deps.repo.upsert(makeTrail({ id: "seed:top", name: "Trail top", distanceMinMi: 9, distanceMaxMi: 10 }));
    const r = await searchHikes(deps, "42", { query: "anything", queryVector: unit(0), limit: 1, maxDistanceMi: 3 });
    expect(r.hits).toHaveLength(0);
    expect(r.hiddenClosed).toBe(1);
  });
});

describe("searchHikes exact-name lookup", () => {
  it("finds a hike by exact name straight from D1, before its vector exists", async () => {
    await deps.repo.upsert(makeTrail({ id: "u:new", owner: "1", name: "Demo Loop" })); // no indexTrail call
    const r = await searchHikes(deps, "1", { query: "demo loop" });
    expect(r.hits[0]?.trail.id).toBe("u:new");
  });
});

describe("searchHikes binding budget", () => {
  it("makes exactly one embed, one vector query and two D1 reads, hidden count included", async () => {
    const calls: string[] = [];
    const counting = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          return typeof v === "function" ? (...args: unknown[]) => { calls.push(`${name}.${String(p)}`); return v.apply(t, args); } : v;
        },
      });
    const counted = { ...deps, repo: counting("repo", deps.repo), embedder: counting("embedder", deps.embedder), vectors: counting("vectors", deps.vectors) };
    const r = await searchHikes(counted, "42", { query: "creek canyon waterfall" });
    expect(r.hiddenClosed).toBe(1);
    expect(calls.sort()).toEqual(["embedder.embed", "repo.findVisibleByName", "repo.getVisibleByIds", "vectors.query"]);
  });
});
