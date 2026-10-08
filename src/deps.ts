import { VectorizeStore } from "./adapters/vectorize";
import { WorkersAiEmbedder } from "./adapters/workers-ai";
import { TrailsRepo } from "./db/trails-repo";
import type { Env } from "./env";
import type { Deps } from "./services/deps";

export function makeDeps(env: Env): Deps {
  return {
    repo: new TrailsRepo(env.DB),
    embedder: new WorkersAiEmbedder(env.AI),
    vectors: new VectorizeStore(env.VECTORIZE),
    now: () => new Date(),
  };
}
