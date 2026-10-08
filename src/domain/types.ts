export type Status = "open" | "closed" | "verify";
export type Difficulty = "easy" | "moderate" | "hard";
export type IndexState = "pending" | "indexed" | "failed";

export const SHARED_OWNER = "shared";
export const DIFFICULTY_RANK: Record<Difficulty, number> = { easy: 1, moderate: 2, hard: 3 };

export interface Trail {
  id: string;
  owner: string; // "shared" or GitHub numeric user id
  name: string;
  area: string;
  trailhead: string;
  routeType: string;
  distanceMinMi: number;
  distanceMaxMi: number;
  gainMinFt: number | null;
  gainMaxFt: number | null;
  difficulty: Difficulty;
  difficultyNote: string | null;
  tags: string[];
  description: string;
  status: Status;
  closedUntil: string | null; // ISO date, inclusive
  statusNote: string | null;
  statusChecked: string; // ISO date
  sourceUrls: string[];
  indexState: IndexState;
  indexedAt: string | null;
}
