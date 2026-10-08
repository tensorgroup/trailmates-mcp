import { describe, expect, it } from "vitest";
import { HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";

const meta = (o: Partial<{ owner: string; distance_max_mi: number }> = {}) => ({
  owner: "shared", status: "open", difficulty_rank: 2, distance_max_mi: 2, ...o,
});

describe("fakes", () => {
  it("ranks the text sharing more words higher", async () => {
    const e = new HashEmbedder();
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: "a", values: await e.embed("creek waterfall shade"), metadata: meta() },
      { id: "b", values: await e.embed("exposed summit radio towers"), metadata: meta() },
    ]);
    const hits = await store.query(await e.embed("shady waterfall creek"), { topK: 2, filter: { owner: { $in: ["shared"] } } });
    expect(hits[0]?.id).toBe("a");
  });
  it("applies $in, $lte and $eq filters and rejects unsupported operators", async () => {
    const store = new InMemoryVectorStore();
    const v = [1, 0];
    await store.upsert([
      { id: "mine", values: v, metadata: meta({ owner: "1", distance_max_mi: 5 }) },
      { id: "theirs", values: v, metadata: meta({ owner: "2", distance_max_mi: 1 }) },
    ]);
    const ids = async (filter: Record<string, unknown>) => (await store.query(v, { topK: 10, filter })).map((h) => h.id);
    expect(await ids({ owner: { $in: ["shared", "1"] } })).toEqual(["mine"]);
    expect(await ids({ distance_max_mi: { $lte: 2 } })).toEqual(["theirs"]);
    expect(await ids({ owner: { $eq: "2" } })).toEqual(["theirs"]);
    await expect(ids({ owner: { $nope: 1 } })).rejects.toThrow(/unsupported/);
  });
  it("rejects a non-array $in argument, like the real filter syntax", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([{ id: "mine", values: [1, 0], metadata: meta({ owner: "1" }) }]);
    await expect(store.query([1, 0], { topK: 10, filter: { owner: { $in: "1" } } })).rejects.toThrow(/\$in/);
  });
  it("enforces Vectorize's topK limit of 100", async () => {
    const store = new InMemoryVectorStore();
    await expect(store.query([1, 0], { topK: 100, filter: {} })).resolves.toEqual([]);
    await expect(store.query([1, 0], { topK: 101, filter: {} })).rejects.toThrow(/topK/);
  });
  it("can fail one upsert on demand", async () => {
    const store = new InMemoryVectorStore();
    store.failNextUpsert();
    await expect(store.upsert([])).rejects.toThrow();
    await expect(store.upsert([])).resolves.toBeUndefined();
  });
});
