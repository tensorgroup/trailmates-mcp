import type { VectorRecord, VectorStore } from "../ports";

const BATCH = 500;

export class VectorizeStore implements VectorStore {
  constructor(private readonly index: Vectorize) {}

  async upsert(records: VectorRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH).map((r) => ({
        id: r.id,
        values: r.values,
        metadata: r.metadata as unknown as Record<string, VectorizeVectorMetadata>,
      }));
      await this.index.upsert(batch);
    }
  }

  async query(values: number[], opts: { topK: number; filter: Record<string, unknown> }) {
    const res = await this.index.query(values, {
      topK: opts.topK,
      filter: opts.filter as VectorizeVectorMetadataFilter,
      returnMetadata: "none",
    });
    return res.matches.map((m) => ({ id: m.id, score: m.score }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.index.deleteByIds(ids);
  }
}
