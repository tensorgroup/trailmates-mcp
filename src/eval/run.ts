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
