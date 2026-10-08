import { embeddingText, toVectorMetadata } from "../domain/search-rules";
import type { Trail } from "../domain/types";
import type { Deps } from "./deps";

export const REINDEX_CHUNK = 20;

export interface ReindexResult {
  indexed: number;
  failed: number;
  remaining: number; // rows still not indexed (includes rows that failed)
}

export async function reindexTrails(deps: Deps, opts: { limit?: number } = {}): Promise<ReindexResult> {
  const rows = await deps.repo.listForReindex(opts.limit ?? REINDEX_CHUNK);
  let indexed = 0;
  let failed = 0;
  if (rows.length > 0) {
    const ids = rows.map((t) => t.id);
    try {
      const values = await deps.embedder.embedMany(rows.map(embeddingText));
      await deps.vectors.upsert(rows.map((t, i) => ({ id: t.id, values: values[i]!, metadata: toVectorMetadata(t) })));
      await deps.repo.setIndexStateMany(ids, "indexed", deps.now());
      indexed = ids.length;
    } catch (err) {
      console.error("reindex failed", err instanceof Error ? err.message : "unknown error");
      await deps.repo.setIndexStateMany(ids, "failed", deps.now());
      failed = ids.length;
    }
  }
  return { indexed, failed, remaining: await deps.repo.countUnindexed() };
}

export async function seedShared(deps: Deps, trails: Trail[]): Promise<ReindexResult> {
  await deps.repo.upsertMany(trails.map((t) => ({ ...t, indexState: "pending" as const, indexedAt: null })));
  return reindexTrails(deps);
}
