import type { VectorMetadata } from "../../src/domain/search-rules";
import type { Embedder, VectorRecord, VectorStore } from "../../src/ports";

const DIMS = 256;

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic bag-of-words embedder: shared words => higher cosine similarity. */
export class HashEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(DIMS).fill(0);
    for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[hash(w) % DIMS]! += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

export class FailingEmbedder implements Embedder {
  async embed(): Promise<number[]> {
    throw new Error("embedding unavailable");
  }
  async embedMany(): Promise<number[][]> {
    throw new Error("embedding unavailable");
  }
}

function matches(meta: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const v = meta[key];
    if (typeof cond !== "object" || cond === null) {
      if (v !== cond) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(cond as Record<string, unknown>)) {
      if (op === "$eq") { if (v !== arg) return false; }
      else if (op === "$in") { if (!(arg as unknown[]).includes(v)) return false; }
      else if (op === "$lte") { if (typeof v !== "number" || v > (arg as number)) return false; }
      else throw new Error(`fake vector store: unsupported operator ${op}`);
    }
  }
  return true;
}

export class InMemoryVectorStore implements VectorStore {
  readonly records = new Map<string, VectorRecord>();
  private failUpsert = false;

  failNextUpsert(): void {
    this.failUpsert = true;
  }
  /** Plant a vector directly, e.g. a stale id or a foreign user's vector. */
  injectRaw(id: string, values: number[], metadata: VectorMetadata): void {
    this.records.set(id, { id, values, metadata });
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (this.failUpsert) {
      this.failUpsert = false;
      throw new Error("vectorize unavailable");
    }
    for (const r of records) this.records.set(r.id, r);
  }

  async query(values: number[], opts: { topK: number; filter: Record<string, unknown> }) {
    const scored = [...this.records.values()]
      .filter((r) => matches(r.metadata as unknown as Record<string, unknown>, opts.filter))
      .map((r) => ({ id: r.id, score: r.values.reduce((s, x, i) => s + x * (values[i] ?? 0), 0) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.topK);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }
}
