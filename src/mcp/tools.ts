import { z } from "zod";
import type { SearchHit } from "../services/search";
import { searchHikes } from "../services/search";
import { UserError, addHike, addHikeSchema, deleteHike } from "../services/hikes";
import type { Deps } from "../services/deps";
import { isoDate } from "../domain/iso-date";
import { SHARED_OWNER } from "../domain/types";

export interface ToolContext {
  deps: Deps;
  userId: string;
  scopes: string[];
}

// A type alias (not an interface) so it is assignable to the SDK's CallToolResult index signature.
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const searchHikesShape = {
  query: z.string().trim().min(1).max(500),
  max_distance: z.number().positive().max(200).optional(),
  max_gain: z.number().nonnegative().max(20000).optional(),
  difficulty: z.enum(["easy", "moderate", "hard"]).optional(),
  include_closed: z.boolean().optional(),
  date: isoDate.optional(),
  limit: z.number().int().min(1).max(25).optional(),
};
export const addHikeShape = addHikeSchema.shape;
export const deleteHikeShape = { trail_id: z.string().min(1).max(64) };

export function requireScope(scopes: string[], scope: string): void {
  if (!scopes.includes(scope)) throw new UserError(`this action needs the ${scope} permission`);
}

/**
 * Combines the verified token props with the SDK's authInfo scopes. Props are the fallback only when
 * authInfo carries no scope list at all; an explicit empty list means no permissions.
 */
export function resolveToolAuth(
  props: Record<string, unknown> | undefined,
  authScopes: string[] | undefined,
): { userId: string; scopes: string[] } {
  const userId = props?.userId;
  if (typeof userId !== "string" || userId === "") throw new UserError("not signed in");
  const propScopes = props?.scopes;
  const fromProps = Array.isArray(propScopes) ? propScopes.filter((x): x is string => typeof x === "string") : [];
  return { userId, scopes: authScopes !== undefined ? authScopes : fromProps };
}

function presentHit(h: SearchHit) {
  const t = h.trail;
  return {
    id: t.id,
    name: t.name,
    area: t.area,
    trailhead: t.trailhead,
    route_type: t.routeType,
    distance_mi: [t.distanceMinMi, t.distanceMaxMi],
    gain_ft: t.gainMinFt === null || t.gainMaxFt === null ? null : [t.gainMinFt, t.gainMaxFt],
    difficulty: t.difficulty,
    difficulty_note: t.difficultyNote,
    tags: t.tags,
    description: t.description,
    source: t.owner === SHARED_OWNER ? "shared" : "private",
    status: h.availability === "excluded" ? "closed" : h.availability,
    closed_through: h.closedThrough,
    status_note: t.statusNote,
    status_checked: t.statusChecked,
    flags: h.flags,
    score: h.score,
  };
}

export async function searchHikesTool(ctx: ToolContext, rawArgs: unknown) {
  requireScope(ctx.scopes, "mcp:read"); // the OAuth provider advertises scopes but does not enforce them
  const a = z.object(searchHikesShape).parse(rawArgs);
  const hits = await searchHikes(ctx.deps, ctx.userId, {
    query: a.query,
    maxDistanceMi: a.max_distance,
    maxGainFt: a.max_gain,
    difficulty: a.difficulty,
    includeClosed: a.include_closed,
    date: a.date,
    limit: a.limit,
  });
  return { count: hits.length, results: hits.map(presentHit) };
}

export async function addHikeTool(ctx: ToolContext, rawArgs: unknown) {
  requireScope(ctx.scopes, "mcp:write");
  const r = await addHike(ctx.deps, ctx.userId, addHikeSchema.parse(rawArgs));
  return { id: r.id, index_state: r.indexState, message: r.message };
}

export async function deleteHikeTool(ctx: ToolContext, rawArgs: unknown) {
  requireScope(ctx.scopes, "mcp:write");
  const a = z.object(deleteHikeShape).parse(rawArgs);
  return deleteHike(ctx.deps, ctx.userId, a.trail_id);
}

export async function callTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    if (err instanceof UserError) return { isError: true, content: [{ type: "text", text: err.message }] };
    if (err instanceof z.ZodError) {
      const msg = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return { isError: true, content: [{ type: "text", text: `invalid input: ${msg}` }] };
    }
    // Operators need the message to diagnose failures; the caller only ever sees the generic text.
    console.error("tool failed", err instanceof Error ? `${err.name}: ${err.message}` : "unknown");
    return { isError: true, content: [{ type: "text", text: "internal error; please try again" }] };
  }
}
