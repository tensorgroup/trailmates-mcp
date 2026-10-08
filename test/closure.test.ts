import { describe, expect, it } from "vitest";
import { evaluateClosure, laToday } from "../src/domain/closure";

const open = { status: "open" as const, closedUntil: null, statusChecked: "2026-10-01" };

describe("laToday", () => {
  it("uses the Los Angeles calendar date, not UTC", () => {
    expect(laToday(new Date("2026-10-08T03:00:00Z"))).toBe("2026-10-07"); // 8pm PDT on the 7th
    expect(laToday(new Date("2026-10-08T08:00:00Z"))).toBe("2026-10-08");
  });
});

describe("evaluateClosure truth table", () => {
  it("closed with no date is excluded as an indefinite closure", () => {
    const r = evaluateClosure({ ...open, status: "closed" }, "2026-10-07");
    expect(r).toMatchObject({ availability: "excluded", closedThrough: null });
  });
  it("closed through a future date is excluded and reports the reopening date", () => {
    const r = evaluateClosure({ ...open, status: "closed", closedUntil: "2027-12-31" }, "2026-10-07");
    expect(r).toMatchObject({ availability: "excluded", closedThrough: "2027-12-31" });
  });
  it("closed_until is inclusive: the boundary day is still closed", () => {
    const r = evaluateClosure({ ...open, status: "closed", closedUntil: "2027-12-31" }, "2027-12-31");
    expect(r.availability).toBe("excluded");
  });
  it("the day after closed_until is verify, never open", () => {
    const r = evaluateClosure({ ...open, status: "closed", closedUntil: "2027-12-31" }, "2028-01-01");
    expect(r.availability).toBe("verify");
    expect(r.flags.join(" ")).toMatch(/may have ended/);
  });
  it("verify status is returned with a flag", () => {
    const r = evaluateClosure({ ...open, status: "verify" }, "2026-10-07");
    expect(r.availability).toBe("verify");
    expect(r.flags.length).toBeGreaterThan(0);
  });
  it("open with a future closed_until is contradictory and treated as closed", () => {
    const r = evaluateClosure({ ...open, closedUntil: "2026-12-01" }, "2026-10-07");
    expect(r).toMatchObject({ availability: "excluded", closedThrough: "2026-12-01" });
    expect(r.flags.join(" ")).toMatch(/conflicting/);
  });
  it("open with a stale past closed_until is available", () => {
    const r = evaluateClosure({ ...open, closedUntil: "2026-01-01" }, "2026-10-07");
    expect(r.availability).toBe("available");
  });
  it("open is available, and flags a status older than 180 days", () => {
    expect(evaluateClosure(open, "2026-10-07")).toEqual({ availability: "available", closedThrough: null, flags: [] });
    const stale = evaluateClosure({ ...open, statusChecked: "2026-01-01" }, "2026-10-07");
    expect(stale.availability).toBe("available");
    expect(stale.flags.join(" ")).toMatch(/last checked 2026-01-01/);
  });
});
