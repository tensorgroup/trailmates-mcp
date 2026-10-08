import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TrailsRepo } from "../src/db/trails-repo";
import { addHikeTool, callTool, deleteHikeTool, requireScope, resolveToolAuth, searchHikesTool, type ToolContext } from "../src/mcp/tools";
import { UserError } from "../src/services/hikes";
import { seedShared } from "../src/services/indexing";
import { applySchema, clearTrails } from "./helpers/db";
import { HashEmbedder, InMemoryVectorStore } from "./helpers/fakes";
import { makeTrail } from "./helpers/fixtures";

const db = (env as unknown as { DB: D1Database }).DB;
let ctx: ToolContext;

beforeAll(async () => applySchema(db));
beforeEach(async () => {
  await clearTrails(db);
  const deps = { repo: new TrailsRepo(db), embedder: new HashEmbedder(), vectors: new InMemoryVectorStore(), now: () => new Date("2026-10-07T20:00:00Z") };
  ctx = { deps, userId: "1", scopes: ["mcp:read", "mcp:write"] };
  await seedShared(deps, [
    makeTrail({ id: "seed:falls", name: "Hidden Falls", description: "Shady creek walk to a waterfall.", tags: ["waterfall"] }),
    makeTrail({ id: "seed:eaton", name: "Eaton Canyon Falls", description: "Creek canyon waterfall.", status: "closed", closedUntil: "2027-12-31" }),
  ]);
});

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

/** Throws on any use, so a test fails loudly if a code path touches the binding. */
const forbidden = (name: string) =>
  new Proxy({}, { get: (_t, p) => { throw new Error(`${name}.${String(p)} must not be used`); } });
/** A context whose data bindings throw if touched; scopes are granted unless overridden. */
const untouchable = (scopes: string[] = ["mcp:read", "mcp:write"]): ToolContext => ({
  deps: { repo: forbidden("repo"), embedder: forbidden("embedder"), vectors: forbidden("vectors"), now: () => new Date("2026-10-07T20:00:00Z") } as unknown as ToolContext["deps"],
  userId: "1",
  scopes,
});

describe("search_hikes tool", () => {
  it("returns compact hits without leaking owner ids", async () => {
    const r = await callTool(() => searchHikesTool(ctx, { query: "shady creek waterfall" }));
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(text(r));
    expect(body.results[0]).toMatchObject({ id: "seed:falls", name: "Hidden Falls", source: "shared", status: "available" });
    expect(JSON.stringify(body)).not.toContain('"owner"');
  });
  it("returns address as null for hikes that have none", async () => {
    const body = JSON.parse(text(await callTool(() => searchHikesTool(ctx, { query: "shady creek waterfall" }))));
    expect(body.results[0]).toHaveProperty("address", null);
  });
  it("reports closed trails with the reopening date when include_closed is true", async () => {
    const body = JSON.parse(text(await callTool(() => searchHikesTool(ctx, { query: "creek canyon waterfall", include_closed: true }))));
    expect(body.results.find((x: { id: string }) => x.id === "seed:eaton")).toMatchObject({ status: "closed", closed_through: "2027-12-31" });
  });
  it.each([
    [{ query: "" }],
    [{ query: "   " }],
    [{ query: "x".repeat(501) }],
    [{ query: "hike", max_distance: 0 }],
    [{ query: "hike", max_distance: -1 }],
    [{ query: "hike", max_distance: Number.NaN }],
    [{ query: "hike", max_gain: -1 }],
    [{ query: "hike", limit: 26 }],
    [{ query: "hike", difficulty: "extreme" }],
    [{ query: "hike", date: "2026-02-30" }],
    [{ query: "hike", date: "10/07/2026" }],
  ])("rejects invalid input %j with a clear error before touching any data", async (args) => {
    const r = await callTool(() => searchHikesTool(untouchable(), args));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid input/);
  });
});

describe("add_hike / delete_hike tools", () => {
  const args = { name: "Backyard Loop", area: "Altadena", trailhead: "Maple St", route_type: "loop", distance_mi: 2, difficulty: "easy", description: "Quiet oak loop." };
  it("adds then deletes a private hike", async () => {
    const added = JSON.parse(text(await callTool(() => addHikeTool(ctx, args))));
    expect(added.index_state).toBe("indexed");
    const found = JSON.parse(text(await callTool(() => searchHikesTool(ctx, { query: "quiet oak loop" }))));
    expect(found.results.map((x: { id: string }) => x.id)).toContain(added.id);
    const del = await callTool(() => deleteHikeTool(ctx, { trail_id: added.id }));
    expect(del.isError).toBeUndefined();
  });
  it("stores an optional trimmed address and returns it from search", async () => {
    const added = JSON.parse(text(await callTool(() => addHikeTool(ctx, { ...args, address: "  12 Maple St, Altadena, CA  " }))));
    const found = JSON.parse(text(await callTool(() => searchHikesTool(ctx, { query: "quiet oak loop" }))));
    expect(found.results.find((x: { id: string }) => x.id === added.id)).toMatchObject({ address: "12 Maple St, Altadena, CA" });
  });
  it("saves a hike without an address as address null", async () => {
    const added = JSON.parse(text(await callTool(() => addHikeTool(ctx, args))));
    expect((await ctx.deps.repo.getVisible(added.id, "1"))?.address).toBeNull();
  });
  it.each([["x".repeat(201)], ["   "]])("rejects an invalid address %j before touching any data", async (address) => {
    const r = await callTool(() => addHikeTool(untouchable(), { ...args, address }));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid input/);
  });
  it("requires the mcp:write scope and leaves data untouched when refused", async () => {
    const added = JSON.parse(text(await callTool(() => addHikeTool(ctx, args))));
    const readOnly = { ...ctx, scopes: ["mcp:read"] };
    expect((await callTool(() => addHikeTool(readOnly, { ...args, name: "Second" }))).isError).toBe(true);
    const del = await callTool(() => deleteHikeTool(readOnly, { trail_id: added.id }));
    expect(del.isError).toBe(true);
    expect(text(del)).toMatch(/mcp:write/);
    expect(await ctx.deps.repo.getVisible(added.id, "1")).not.toBeNull();
    expect(await ctx.deps.repo.countOwned("1")).toBe(1);
  });
  it("requires mcp:read before touching any data", async () => {
    const r = await callTool(() => searchHikesTool(untouchable([]), { query: "waterfall" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/needs the mcp:read permission/);
  });
  it("turns unexpected errors into a generic message that leaks nothing", async () => {
    const r = await callTool(async () => { throw new Error("secret-token-abc123 database exploded"); });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain("secret-token");
  });
  it("logs the error name and message for operators while the response stays generic", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
      const r = await callTool(async () => { throw new TypeError("binding DB went away"); });
      expect(text(r)).toBe("internal error; please try again");
      expect(text(r)).not.toContain("binding DB went away");
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([["tool failed", "TypeError: binding DB went away"]]);
  });
});

describe("resolveToolAuth", () => {
  it("reads the user id from props and prefers authInfo scopes, falling back to props.scopes", () => {
    expect(resolveToolAuth({ userId: "7", scopes: ["mcp:read"] }, ["mcp:read", "mcp:write"])).toEqual({ userId: "7", scopes: ["mcp:read", "mcp:write"] });
    expect(resolveToolAuth({ userId: "7", scopes: ["mcp:read"] }, undefined)).toEqual({ userId: "7", scopes: ["mcp:read"] });
    expect(resolveToolAuth({ userId: "7" }, [])).toEqual({ userId: "7", scopes: [] });
  });
  it("keeps an explicitly empty authInfo scope list empty even when props.scopes has values", () => {
    expect(resolveToolAuth({ userId: "7", scopes: ["mcp:read", "mcp:write"] }, [])).toEqual({ userId: "7", scopes: [] });
  });
  it("rejects missing or non-string user ids", () => {
    expect(() => resolveToolAuth(undefined, ["mcp:read"])).toThrow(UserError);
    expect(() => resolveToolAuth({ userId: 7 }, ["mcp:read"])).toThrow(UserError);
    expect(() => resolveToolAuth({ userId: "" }, ["mcp:read"])).toThrow(UserError);
  });
});

describe("requireScope", () => {
  it("passes when present and throws UserError when missing", () => {
    expect(() => requireScope(["mcp:write"], "mcp:write")).not.toThrow();
    expect(() => requireScope(["mcp:read"], "mcp:write")).toThrow(UserError);
  });
});
