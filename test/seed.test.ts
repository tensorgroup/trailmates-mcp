import { describe, expect, it } from "vitest";
import seedJson from "../data/trails.seed.json";
import { normalizeSeed } from "../src/domain/seed";

describe("normalizeSeed", () => {
  const trails = normalizeSeed(seedJson);
  const byId = new Map(trails.map((t) => [t.id, t]));

  it("loads all seed trails as shared, pending, with seed: ids", () => {
    expect(trails.length).toBe(18);
    for (const t of trails) {
      expect(t.owner).toBe("shared");
      expect(t.id.startsWith("seed:")).toBe(true);
      expect(t.indexState).toBe("pending");
      expect(t.sourceUrls.length).toBeGreaterThan(0);
      expect(t.id.length).toBeLessThanOrEqual(64);
    }
  });
  it("gives every seed trail a trailhead address", () => {
    for (const t of trails) {
      expect(t.address, t.id).toBeTruthy();
      expect(t.address!.length, t.id).toBeLessThanOrEqual(200);
    }
  });
  it("keeps descriptions short", () => {
    for (const t of trails) expect(t.description.length, t.id).toBeLessThanOrEqual(200);
  });
  it("rejects a seed trail without an address", () => {
    const { address: _omit, ...first } = seedJson.trails[0]!;
    expect(() => normalizeSeed({ trails: [first] })).toThrow();
  });
  it("has unique ids", () => {
    expect(new Set(trails.map((t) => t.id)).size).toBe(trails.length);
  });
  it("normalizes difficulty text and keeps the original as a note", () => {
    const solstice = byId.get("seed:solstice-canyon-malibu")!;
    expect(solstice.difficulty).toBe("moderate");
    expect(solstice.difficultyNote).toBe("easy to moderate");
    expect(byId.get("seed:verdugo-peak-from-la-tuna")!.difficultyNote).toBeNull();
  });
  it("keeps the Eaton closures with their dates and notes", () => {
    for (const id of ["seed:eaton-canyon-nature-center", "seed:eaton-canyon-pinecrest"]) {
      const t = byId.get(id)!;
      expect(t.status).toBe("closed");
      expect(t.closedUntil).toBe("2027-12-31");
      expect(t.statusNote).toBeTruthy();
    }
  });
  it("uses null for unknown gain", () => {
    const lukens = byId.get("seed:mount-lukens-via-deukmejian")!;
    expect(lukens.gainMinFt).toBeNull();
    expect(lukens.gainMaxFt).toBeNull();
  });
  it("keeps Millard Falls closed through the Eaton Fire area closure", () => {
    const millard = byId.get("seed:millard-falls")!;
    expect(millard.status).toBe("closed");
    expect(millard.closedUntil).toBe("2027-12-31");
    expect(millard.statusNote).toBeTruthy();
  });
  it("rejects malformed seed data", () => {
    expect(() => normalizeSeed({ trails: [{ id: "x" }] })).toThrow();
  });
  it("rejects impossible calendar dates", () => {
    const first = seedJson.trails[0]!;
    expect(() => normalizeSeed({ trails: [{ ...first, status_checked: "2026-10-01" }] })).not.toThrow();
    expect(() => normalizeSeed({ trails: [{ ...first, status_checked: "2026-02-30" }] })).toThrow(/real calendar date/);
    expect(() => normalizeSeed({ trails: [{ ...first, status: "closed", closed_until: "2027-13-01" }] })).toThrow(/real calendar date/);
  });
});
