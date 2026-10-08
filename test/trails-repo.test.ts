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
  it("round-trips a trailhead address and keeps null when there is none", async () => {
    const t = makeTrail({ id: "seed:addr", address: "1750 N Altadena Dr, Pasadena, CA 91107" });
    await repo.upsert(t);
    expect(await repo.getVisible("seed:addr", "1")).toEqual(t);
    await repo.upsert(makeTrail({ id: "seed:none" }));
    expect((await repo.getVisible("seed:none", "1"))?.address).toBeNull();
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
  it("updates the address on upsert, including through the capped insert", async () => {
    await repo.upsert(makeTrail({ id: "u:a", owner: "1", address: "Old St" }));
    await repo.upsert(makeTrail({ id: "u:a", owner: "1", address: "New St" }));
    expect((await repo.getVisible("u:a", "1"))?.address).toBe("New St");
    expect(await repo.upsert(makeTrail({ id: "u:a", owner: "1", address: null }), { maxOwned: 5 })).toBe(true);
    expect((await repo.getVisible("u:a", "1"))?.address).toBeNull();
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
