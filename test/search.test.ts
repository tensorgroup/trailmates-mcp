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
