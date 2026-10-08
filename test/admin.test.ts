import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";

const calls: string[] = [];
const actions = {
  seed: async () => { calls.push("seed"); return { ok: 1 }; },
  reindex: async (only: boolean) => { calls.push(`reindex:${only}`); return { ok: 2 }; },
  evalRun: async () => { calls.push("eval"); return { ok: 3 }; },
};
const req = (path: string, token?: string, method = "POST") =>
  new Request(`https://x.dev${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("handleAdmin", () => {
  it("is disabled (404) when no ADMIN_TOKEN is configured", async () => {
    expect((await handleAdmin(req("/admin/seed", "anything"), undefined, actions)).status).toBe(404);
  });
  it("rejects a missing or wrong token with 401 and runs nothing", async () => {
    calls.length = 0;
    expect((await handleAdmin(req("/admin/seed"), "s3cret", actions)).status).toBe(401);
    expect((await handleAdmin(req("/admin/seed", "wrong"), "s3cret", actions)).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("runs the requested action with the right token, POST only", async () => {
    calls.length = 0;
    expect((await handleAdmin(req("/admin/seed", "s3cret"), "s3cret", actions)).status).toBe(200);
    expect((await handleAdmin(req("/admin/reindex?all=1", "s3cret"), "s3cret", actions)).status).toBe(200);
    expect((await handleAdmin(req("/admin/eval", "s3cret"), "s3cret", actions)).status).toBe(200);
    expect(calls).toEqual(["seed", "reindex:false", "eval"]);
    expect((await handleAdmin(req("/admin/seed", "s3cret", "GET"), "s3cret", actions)).status).toBe(405);
    expect((await handleAdmin(req("/admin/nope", "s3cret"), "s3cret", actions)).status).toBe(404);
  });
});
