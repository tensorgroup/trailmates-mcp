import { describe, expect, it } from "vitest";
import { buildVectorFilter, checkConstraints, embeddingText, toVectorMetadata } from "../src/domain/search-rules";
import { makeTrail } from "./helpers/fixtures";

describe("checkConstraints", () => {
  it("matches distance on the upper bound: Runyon 2.8-3.5 mi does not pass max_distance 3", () => {
    const runyon = makeTrail({ distanceMinMi: 2.8, distanceMaxMi: 3.5 });
    expect(checkConstraints(runyon, { maxDistanceMi: 3 }).ok).toBe(false);
    expect(checkConstraints(runyon, { maxDistanceMi: 3.5 }).ok).toBe(true);
  });
  it("excludes unknown gain when a gain limit is set, flags it otherwise", () => {
    const unknown = makeTrail({ gainMinFt: null, gainMaxFt: null });
    expect(checkConstraints(unknown, { maxGainFt: 5000 }).ok).toBe(false);
    expect(checkConstraints(unknown, {})).toEqual({ ok: true, flags: ["gain unknown"] });
  });
  it("matches the normalized difficulty exactly", () => {
    expect(checkConstraints(makeTrail({ difficulty: "moderate" }), { difficulty: "easy" }).ok).toBe(false);
    expect(checkConstraints(makeTrail({ difficulty: "moderate" }), { difficulty: "moderate" }).ok).toBe(true);
  });
});

describe("buildVectorFilter", () => {
  it("always scopes to shared plus the caller", () => {
    expect(buildVectorFilter("42", {})).toEqual({ owner: { $in: ["shared", "42"] } });
  });
  it("adds numeric and difficulty filters and stays under 2048 bytes", () => {
    const f = buildVectorFilter("42", { maxDistanceMi: 3, maxGainFt: 500, difficulty: "hard" });
    expect(f).toEqual({
      owner: { $in: ["shared", "42"] },
      distance_max_mi: { $lte: 3 },
      gain_max_ft: { $lte: 500 },
      difficulty_rank: { $eq: 3 },
    });
    expect(JSON.stringify(f).length).toBeLessThan(2048);
  });
});

describe("toVectorMetadata / embeddingText", () => {
  it("omits gain_max_ft when gain is unknown", () => {
    const m = toVectorMetadata(makeTrail({ gainMaxFt: null }));
    expect("gain_max_ft" in m).toBe(false);
    expect(m).toMatchObject({ owner: "shared", status: "open", difficulty_rank: 2 });
  });
  it("embeds name, area, difficulty, distance, tags and description", () => {
    const text = embeddingText(makeTrail({ name: "Test Falls", area: "Altadena", tags: ["waterfall"], description: "Cool creek." }));
    expect(text).toContain("Test Falls");
    expect(text).toContain("Altadena");
    expect(text).toContain("waterfall");
    expect(text).toContain("moderate");
    expect(text).toContain("Cool creek.");
  });
});
