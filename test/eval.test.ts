import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { EVAL_CASES, MAX_EVAL_CASES } from "../src/eval/fixtures";
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

/** Counts every embedding call, whichever method is used. */
class CountingEmbedder extends HashEmbedder {
  calls = 0;
  override async embed(text: string): Promise<number[]> {
    this.calls++;
    return super.embed(text);
  }
  override async embedMany(texts: string[]): Promise<number[][]> {
    this.calls++;
    return Promise.all(texts.map((t) => super.embed(t)));
  }
}

/** Returns no matches on the listed (0-based) query calls, to simulate a case that finds nothing. */
class BlankingVectorStore extends InMemoryVectorStore {
  private call = 0;
  constructor(private readonly blank: Set<number>) {
    super();
  }
  override async query(values: number[], opts: { topK: number; filter: Record<string, unknown> }) {
    const n = this.call++;
    return this.blank.has(n) ? [] : super.query(values, opts);
  }
}

describe("runEval metrics", () => {
  it("computes distinguishable top1, hit@3 and MRR with a rank-2 case", async () => {
    await seedShared(deps, [makeTrail({ id: "seed:d", name: "D", description: "creek meadow" })]);
    const report = await runEval(deps, [
      { date: D, query: "shady creek waterfall", relevant: ["seed:a"], mustNotInclude: ["seed:c"] }, // rank 1
      { date: D, query: "creek waterfall", relevant: ["seed:d"] }, // A outranks D: rank 2
      { date: D, query: "waterfall", relevant: ["seed:nonexistent"] }, // miss
    ]);
    expect(report.perCase.map((c) => c.rank)).toEqual([1, 2, null]);
    expect(report.ready).toBe(true);
    expect(report.cases).toBe(3);
    expect(report.scored).toBe(3);
    expect(report.top1).toBeCloseTo(1 / 3); // only case 1
    expect(report.hitAt3).toBeCloseTo(2 / 3); // cases 1 and 2
    expect(report.mrr).toBeCloseTo((1 + 1 / 2) / 3); // 0.5
    expect(new Set([report.top1, report.hitAt3, report.mrr]).size).toBe(3);
    expect(report.violations).toEqual([]);
  });
  it("excludes unscored cases (empty relevant) from the divisor", async () => {
    const report = await runEval(deps, [
      { date: D, query: "shady creek waterfall", relevant: ["seed:a"] },
      { date: D, query: "waterfall", relevant: [], mustNotInclude: ["seed:c"] },
    ]);
    expect(report.cases).toBe(2);
    expect(report.scored).toBe(1);
    expect(report.top1).toBe(1);
    expect(report.hitAt3).toBe(1);
    expect(report.mrr).toBe(1);
  });
  it("reports a violation when a forbidden trail appears", async () => {
    const report = await runEval(deps, [{ date: D, query: "creek waterfall canyon", relevant: ["seed:a"], mustNotInclude: ["seed:a"] }]);
    expect(report.violations.length).toBe(1);
  });
  it("checks forbidden ids beyond the top 10 (up to 25)", async () => {
    const fillers = Array.from({ length: 12 }, (_, i) => makeTrail({ id: `seed:f${i}`, name: `F${i}`, description: "waterfall waterfall" }));
    await seedShared(deps, [...fillers, makeTrail({ id: "seed:z", name: "Z", description: "unrelated meadow" })]);
    const report = await runEval(deps, [{ date: D, query: "waterfall", relevant: ["seed:f0"], mustNotInclude: ["seed:z"] }]);
    expect(report.perCase[0]!.rank).toBe(1);
    expect(report.violations).toEqual(['"waterfall" returned forbidden seed:z']);
  });
  it("reports not ready when nothing is visible, so an empty index cannot pass", async () => {
    await clearTrails(db);
    const report = await runEval(deps, [{ date: D, query: "waterfall", relevant: ["seed:a"], mustNotInclude: ["seed:c"] }]);
    expect(report.ready).toBe(false);
    expect(report.violations).toEqual([]);
  });
  it("reports not ready when any scored case returns no hits, even if others do", async () => {
    const vectors = new BlankingVectorStore(new Set([1]));
    const blanking: Deps = { ...deps, vectors };
    await seedShared(blanking, [makeTrail({ id: "seed:a", name: "A", description: "shady creek waterfall" })]);
    const report = await runEval(blanking, [
      { date: D, query: "shady creek waterfall", relevant: ["seed:a"] },
      { date: D, query: "xyzzy plugh", relevant: ["seed:a"] }, // no vector matches and no name match
    ]);
    expect(report.perCase[0]!.rank).toBe(1);
    expect(report.perCase[1]!.rank).toBeNull();
    expect(report.ready).toBe(false);
  });
  it("embeds all case queries in exactly one embedding call", async () => {
    const embedder = new CountingEmbedder();
    const report = await runEval({ ...deps, embedder }, [
      { date: D, query: "shady creek waterfall", relevant: ["seed:a"] },
      { date: D, query: "radio towers summit", relevant: ["seed:b"] },
      { date: D, query: "waterfall", relevant: [] },
    ]);
    expect(embedder.calls).toBe(1);
    expect(report.perCase.map((c) => c.rank)).toEqual([1, 1, null]);
  });
  it("refuses more cases than fit the Workers Free subrequest budget", async () => {
    const tooMany = Array.from({ length: MAX_EVAL_CASES + 1 }, () => ({ date: D, query: "waterfall", relevant: ["seed:a"] }));
    await expect(runEval(deps, tooMany)).rejects.toThrow(/at most 15 cases/);
  });
  it("ships at least 10 frozen, dated cases including a closure-aware negative", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(10);
    expect(EVAL_CASES.length).toBeLessThanOrEqual(MAX_EVAL_CASES);
    expect(EVAL_CASES.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date))).toBe(true);
    expect(EVAL_CASES.some((c) => c.mustNotInclude?.some((id) => id.startsWith("seed:eaton")))).toBe(true);
  });
});
