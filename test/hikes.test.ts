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
