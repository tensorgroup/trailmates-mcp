import type { TrailsRepo } from "../db/trails-repo";
import type { Embedder, VectorStore } from "../ports";

export interface Deps {
  repo: TrailsRepo;
  embedder: Embedder;
  vectors: VectorStore;
  now: () => Date;
}
