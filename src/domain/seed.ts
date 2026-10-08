import { z } from "zod";
import { SHARED_OWNER, type Difficulty, type Trail } from "./types";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableNum = z.number().nonnegative().nullable();

const SeedTrail = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  area: z.string().min(1),
  trailhead: z.string().min(1),
  route_type: z.string().min(1),
  distance_mi: z.tuple([z.number().positive(), z.number().positive()]),
  gain_ft: z.tuple([nullableNum, nullableNum]),
  difficulty: z.string().min(1),
  status: z.enum(["open", "closed", "verify"]),
  closed_until: isoDate.nullable(),
  status_note: z.string().optional(),
  status_checked: isoDate,
  source_urls: z.array(z.url()).min(1),
  tags: z.array(z.string()),
  description: z.string().min(1).max(2000),
});

const SeedFile = z.object({ trails: z.array(SeedTrail).min(1) });

function mapDifficulty(raw: string): Difficulty {
  const s = raw.toLowerCase();
  if (s.includes("hard")) return "hard";
  if (s.includes("moderate")) return "moderate";
  return "easy";
}

export function normalizeSeed(raw: unknown): Trail[] {
  const file = SeedFile.parse(raw);
  return file.trails.map((s): Trail => {
    const difficulty = mapDifficulty(s.difficulty);
    return {
      id: `seed:${s.id}`,
      owner: SHARED_OWNER,
      name: s.name,
      area: s.area,
      trailhead: s.trailhead,
      routeType: s.route_type,
      distanceMinMi: s.distance_mi[0],
      distanceMaxMi: s.distance_mi[1],
      gainMinFt: s.gain_ft[0],
      gainMaxFt: s.gain_ft[1],
      difficulty,
      difficultyNote: s.difficulty.toLowerCase() === difficulty ? null : s.difficulty,
      tags: s.tags,
      description: s.description,
      status: s.status,
      closedUntil: s.closed_until,
      statusNote: s.status_note ?? null,
      statusChecked: s.status_checked,
      sourceUrls: s.source_urls,
      indexState: "pending",
      indexedAt: null,
    };
  });
}
