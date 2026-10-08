import type { VectorMetadata } from "./domain/search-rules";

export interface Embedder {
  embed(text: string): Promise<number[]>;
  /** One round trip for many texts (Workers AI accepts a text array); keeps subrequests low. */
  embedMany(texts: string[]): Promise<number[][]>;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  query(
    values: number[],
    opts: { topK: number; filter: Record<string, unknown> },
  ): Promise<{ id: string; score: number }[]>;
  deleteByIds(ids: string[]): Promise<void>;
}
