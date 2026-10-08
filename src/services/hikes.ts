import { z } from "zod";
import { laToday } from "../domain/closure";
import { SHARED_OWNER, type Trail } from "../domain/types";
import type { Deps } from "./deps";
import { indexTrail } from "./search";

export class UserError extends Error {}

export const MAX_HIKES_PER_USER = 50;
export const MAX_DESCRIPTION = 2000;

export const addHikeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  area: z.string().trim().min(1).max(120),
  trailhead: z.string().trim().min(1).max(200),
  route_type: z.enum(["loop", "out-and-back", "point-to-point", "lollipop"]),
  distance_mi: z.number().positive().max(200),
  gain_ft: z.number().nonnegative().max(20000).optional(),
  difficulty: z.enum(["easy", "moderate", "hard"]),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  description: z.string().trim().min(1).max(MAX_DESCRIPTION),
});
export type AddHikeInput = z.infer<typeof addHikeSchema>;

async function privateHikeId(owner: string, name: string, trailhead: string): Promise<string> {
  const data = new TextEncoder().encode(`${owner}\n${name.toLowerCase()}\n${trailhead.toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `u:${hex.slice(0, 32)}`;
}

export async function addHike(
  deps: Deps,
  userId: string,
  input: AddHikeInput,
): Promise<{ id: string; indexState: "indexed" | "failed"; message: string }> {
  if (userId === SHARED_OWNER) throw new UserError("not signed in");
  const id = await privateHikeId(userId, input.name, input.trailhead);

  const trail: Trail = {
    id,
    owner: userId,
    name: input.name,
    area: input.area,
    trailhead: input.trailhead,
    routeType: input.route_type,
    distanceMinMi: input.distance_mi,
    distanceMaxMi: input.distance_mi,
    gainMinFt: input.gain_ft ?? null,
    gainMaxFt: input.gain_ft ?? null,
    difficulty: input.difficulty,
    difficultyNote: null,
    tags: input.tags,
    description: input.description,
    status: "open",
    closedUntil: null,
    statusNote: null,
    statusChecked: laToday(deps.now()),
    sourceUrls: [],
    indexState: "pending",
    indexedAt: null,
  };
  // The cap is enforced inside the same SQL statement as the insert, so concurrent adds cannot exceed it.
  // The id is derived from the owner, so an existing row is always the caller's own and updates in place:
  // a false result can only mean a new row at the cap.
  if (!(await deps.repo.upsert(trail, { maxOwned: MAX_HIKES_PER_USER }))) {
    throw new UserError(`hike limit reached (${MAX_HIKES_PER_USER}); delete one first`);
  }

  try {
    await indexTrail(deps, trail);
    await deps.repo.setIndexState(id, "indexed", deps.now());
    return { id, indexState: "indexed", message: "Saved. It may take a few seconds to appear in search." };
  } catch (err) {
    console.error("indexing failed", err instanceof Error ? err.message : "unknown error");
    await deps.repo.setIndexState(id, "failed", deps.now());
    return { id, indexState: "failed", message: "Saved; indexing pending. It will appear in search after the next reindex." };
  }
}

export async function deleteHike(deps: Deps, userId: string, id: string): Promise<{ id: string; message: string }> {
  if (!(await deps.repo.deleteOwned(id, userId))) throw new UserError("hike not found");
  try {
    await deps.vectors.deleteByIds([id]);
  } catch (err) {
    // The D1 row is gone, so search drops the orphan vector id on hydration.
    console.error("vector delete failed", err instanceof Error ? err.message : "unknown error");
  }
  return { id, message: "Deleted." };
}
