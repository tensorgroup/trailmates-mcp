import type { Embedder } from "../ports";

const MODEL = "@cf/baai/bge-base-en-v1.5";
const DIMENSIONS = 768;
const MAX_TEXTS_PER_CALL = 50;

export class WorkersAiEmbedder implements Embedder {
  constructor(private readonly ai: Ai) {}

  async embed(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0]!;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_CALL) {
      const chunk = texts.slice(i, i + MAX_TEXTS_PER_CALL);
      const res = (await this.ai.run(MODEL, { text: chunk, pooling: "cls" })) as { data?: number[][] };
      if (!res.data || res.data.length !== chunk.length || res.data.some((v) => v.length !== DIMENSIONS)) {
        throw new Error("embedding failed: unexpected response shape");
      }
      out.push(...res.data);
    }
    return out;
  }
}
