import type { Trail } from "./types";

export interface ClosureResult {
  availability: "available" | "excluded" | "verify";
  closedThrough: string | null;
  flags: string[];
}

const STALE_DAYS = 180;

export function laToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function evaluateClosure(
  t: Pick<Trail, "status" | "closedUntil" | "statusChecked">,
  date: string,
): ClosureResult {
  const until = t.closedUntil;
  if (t.status === "closed") {
    if (until === null) return { availability: "excluded", closedThrough: null, flags: ["closed indefinitely"] };
    if (until >= date) return { availability: "excluded", closedThrough: until, flags: [`closed through ${until}`] };
    return {
      availability: "verify",
      closedThrough: null,
      flags: [`closure listed through ${until} may have ended; verify before going`],
    };
  }
  if (t.status === "verify") {
    return { availability: "verify", closedThrough: null, flags: ["status unverified; check the land manager before going"] };
  }
  if (until !== null && until >= date) {
    return {
      availability: "excluded",
      closedThrough: until,
      flags: [`conflicting data: marked open but closed through ${until}`],
    };
  }
  const flags: string[] = [];
  if (daysBetween(t.statusChecked, date) > STALE_DAYS) flags.push(`status last checked ${t.statusChecked}`);
  return { availability: "available", closedThrough: null, flags };
}
