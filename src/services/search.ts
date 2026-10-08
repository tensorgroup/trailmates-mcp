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
  /** Precomputed embedding of `query`; when given, the embed call is skipped (batch callers like the eval). */
  queryVector?: number[];
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

export interface SearchResult {
  hits: SearchHit[];
  /**
   * Closed trails left out (include_closed not set) that would otherwise have made the result list:
   * among visible candidates that pass every constraint, in rank order and ignoring exact-name
   * matches (which are returned anyway), a closed one counts only if its position is within `limit`.
   */
  hiddenClosed: number;
}

export async function searchHikes(deps: Deps, userId: string, input: SearchInput): Promise<SearchResult> {
  const date = input.date ?? laToday(deps.now());
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const query = input.query.trim();

  const vector = input.queryVector ?? (await deps.embedder.embed(query));
  const matches = await deps.vectors.query(vector, { topK: CANDIDATES, filter: buildVectorFilter(userId, input) });
  // D1 is the authorization boundary: ids that are missing or not visible to this user vanish here.
  const visible = new Map((await deps.repo.getVisibleByIds(matches.map((m) => m.id), userId)).map((t) => [t.id, t]));

  const hits: SearchHit[] = [];
  // Every candidate that would be a result if closures were ignored, in rank order.
  const wouldBe: { id: string; hidden: boolean }[] = [];
  for (const m of matches) {
    const trail = visible.get(m.id);
    if (!trail) continue;
    const constraint = checkConstraints(trail, input);
    if (!constraint.ok) continue;
    const closure = evaluateClosure(trail, date);
    const hidden = closure.availability === "excluded" && !input.includeClosed;
    wouldBe.push({ id: trail.id, hidden });
    if (hidden) continue;
    hits.push({
      trail,
      score: m.score,
      availability: closure.availability,
      closedThrough: closure.closedThrough,
      flags: [...closure.flags, ...constraint.flags],
    });
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
  const hiddenClosed = wouldBe
    .filter((c) => !namedIds.has(c.id))
    .slice(0, limit)
    .filter((c) => c.hidden).length;
  return { hits: [...named, ...hits.filter((h) => !namedIds.has(h.trail.id))].slice(0, limit), hiddenClosed };
}
