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
