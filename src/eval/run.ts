import type { Deps } from "../services/deps";
import { searchHikes } from "../services/search";
import { EVAL_CASES, MAX_EVAL_CASES, type EvalCase } from "./fixtures";

export interface EvalReport {
  ready: boolean; // true only when there is a scored case and EVERY scored case returned at least one hit
  cases: number;
  scored: number; // cases with a non-empty `relevant`; the divisor for top1 / hitAt3 / mrr
  top1: number;
  hitAt3: number;
  mrr: number;
  violations: string[];
  perCase: { query: string; rank: number | null; top3: string[] }[];
}

const EVAL_USER = "eval-user"; // sees only the shared seed
const SCORED_DEPTH = 10; // ranks are scored within the top 10
const FORBIDDEN_DEPTH = 25; // forbidden ids are checked across everything search can return

export async function runEval(deps: Deps, cases: EvalCase[] = EVAL_CASES): Promise<EvalReport> {
  if (cases.length > MAX_EVAL_CASES) {
    throw new Error(`runEval accepts at most ${MAX_EVAL_CASES} cases (got ${cases.length}): Workers Free allows 50 subrequests per invocation`);
  }
  const violations: string[] = [];
  const perCase: EvalReport["perCase"] = [];
  let allScoredHit = true;
  let scored = 0;
  let top1 = 0;
  let hit3 = 0;
  let rr = 0;

  // One embedding call for all cases keeps the run inside the subrequest budget.
  const vectors = cases.length > 0 ? await deps.embedder.embedMany(cases.map((c) => c.query.trim())) : [];

  for (const [i, c] of cases.entries()) {
    const { hits } = await searchHikes(deps, EVAL_USER, { query: c.query, date: c.date, limit: FORBIDDEN_DEPTH, queryVector: vectors[i] });
    const allIds = hits.map((h) => h.trail.id);
    for (const bad of c.mustNotInclude ?? []) {
      if (allIds.includes(bad)) violations.push(`"${c.query}" returned forbidden ${bad}`);
    }
    const ids = allIds.slice(0, SCORED_DEPTH);
    const idx = ids.findIndex((id) => c.relevant.includes(id));
    const rank = idx === -1 ? null : idx + 1;
    perCase.push({ query: c.query, rank, top3: ids.slice(0, 3) });
    if (c.relevant.length === 0) continue;
    scored++;
    if (ids.length === 0) allScoredHit = false;
    if (rank === 1) top1++;
    if (rank !== null && rank <= 3) hit3++;
    if (rank !== null) rr += 1 / rank;
  }
  const n = scored || 1;
  return {
    ready: scored > 0 && allScoredHit,
    cases: cases.length,
    scored,
    top1: top1 / n,
    hitAt3: hit3 / n,
    mrr: rr / n,
    violations,
    perCase,
  };
}
