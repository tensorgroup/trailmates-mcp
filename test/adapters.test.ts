import { describe, expect, it } from "vitest";
import { VectorizeStore } from "../src/adapters/vectorize";
import { WorkersAiEmbedder } from "../src/adapters/workers-ai";

describe("WorkersAiEmbedder", () => {
  it("calls bge-base with cls pooling and returns the first 768-dim vector", async () => {
    const calls: unknown[] = [];
    const ai = { run: async (model: string, input: unknown) => { calls.push([model, input]); return { data: [new Array(768).fill(0.1)] }; } };
    const v = await new WorkersAiEmbedder(ai as unknown as Ai).embed("hello");
    expect(v.length).toBe(768);
    expect(calls[0]).toEqual(["@cf/baai/bge-base-en-v1.5", { text: ["hello"], pooling: "cls" }]);
  });
  it("throws on a malformed response", async () => {
    const ai = { run: async () => ({ data: [[1, 2, 3]] }) };
    await expect(new WorkersAiEmbedder(ai as unknown as Ai).embed("x")).rejects.toThrow(/embedding/);
  });
  it("embedMany sends one call per 50 texts and keeps order", async () => {
    const sizes: number[] = [];
    const ai = { run: async (_m: string, input: { text: string[] }) => { sizes.push(input.text.length); return { data: input.text.map(() => new Array(768).fill(0.2)) }; } };
    const out = await new WorkersAiEmbedder(ai as unknown as Ai).embedMany(Array.from({ length: 120 }, (_, i) => `t${i}`));
    expect(out.length).toBe(120);
    expect(sizes).toEqual([50, 50, 20]);
  });
});

describe("VectorizeStore", () => {
  it("queries with returnMetadata none and maps matches", async () => {
    let seen: unknown;
    const index = { query: async (_v: number[], opts: unknown) => { seen = opts; return { matches: [{ id: "a", score: 0.9 }] }; } };
    const hits = await new VectorizeStore(index as unknown as Vectorize).query([1], { topK: 100, filter: { owner: { $in: ["shared"] } } });
    expect(hits).toEqual([{ id: "a", score: 0.9 }]);
    expect(seen).toEqual({ topK: 100, filter: { owner: { $in: ["shared"] } }, returnMetadata: "none" });
  });
  it("upserts in batches of at most 500", async () => {
    const sizes: number[] = [];
    const index = { upsert: async (batch: unknown[]) => { sizes.push(batch.length); return { mutationId: "m" }; } };
    const recs = Array.from({ length: 1200 }, (_, i) => ({
      id: `id${i}`, values: [0], metadata: { owner: "shared", status: "open", difficulty_rank: 1, distance_max_mi: 1 },
    }));
    await new VectorizeStore(index as unknown as Vectorize).upsert(recs);
    expect(sizes).toEqual([500, 500, 200]);
  });
});
