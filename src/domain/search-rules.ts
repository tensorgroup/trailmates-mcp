import { DIFFICULTY_RANK, SHARED_OWNER, type Difficulty, type Trail } from "./types";

export interface SearchConstraints {
  maxDistanceMi?: number;
  maxGainFt?: number;
  difficulty?: Difficulty;
}

export interface VectorMetadata {
  owner: string;
  status: string;
  difficulty_rank: number;
  distance_max_mi: number;
  gain_max_ft?: number;
}

export function checkConstraints(
  t: Pick<Trail, "distanceMaxMi" | "gainMaxFt" | "difficulty">,
  c: SearchConstraints,
): { ok: boolean; flags: string[] } {
  const flags: string[] = [];
  if (c.maxDistanceMi !== undefined && t.distanceMaxMi > c.maxDistanceMi) return { ok: false, flags };
  if (c.maxGainFt !== undefined) {
    if (t.gainMaxFt === null || t.gainMaxFt > c.maxGainFt) return { ok: false, flags };
  } else if (t.gainMaxFt === null) {
    flags.push("gain unknown");
  }
  if (c.difficulty !== undefined && t.difficulty !== c.difficulty) return { ok: false, flags };
  return { ok: true, flags };
}

export function buildVectorFilter(userId: string, c: SearchConstraints): Record<string, unknown> {
  const filter: Record<string, unknown> = { owner: { $in: [SHARED_OWNER, userId] } };
  if (c.maxDistanceMi !== undefined) filter.distance_max_mi = { $lte: c.maxDistanceMi };
  if (c.maxGainFt !== undefined) filter.gain_max_ft = { $lte: c.maxGainFt };
  if (c.difficulty !== undefined) filter.difficulty_rank = { $eq: DIFFICULTY_RANK[c.difficulty] };
  return filter;
}

export function toVectorMetadata(t: Trail): VectorMetadata {
  const meta: VectorMetadata = {
    owner: t.owner,
    status: t.status,
    difficulty_rank: DIFFICULTY_RANK[t.difficulty],
    distance_max_mi: t.distanceMaxMi,
  };
  if (t.gainMaxFt !== null) meta.gain_max_ft = t.gainMaxFt;
  return meta;
}

export function embeddingText(t: Trail): string {
  const distance =
    t.distanceMinMi === t.distanceMaxMi ? `${t.distanceMaxMi} miles` : `${t.distanceMinMi} to ${t.distanceMaxMi} miles`;
  return [
    `${t.name} in ${t.area}.`,
    `${t.difficulty} ${t.routeType}, ${distance}.`,
    t.tags.length ? `Tags: ${t.tags.join(", ")}.` : "",
    t.description,
  ]
    .filter(Boolean)
    .join(" ");
}
