import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applySchema } from "./helpers/db";

describe("toolchain smoke", () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  beforeAll(async () => applySchema(db));

  it("runs inside the Workers runtime with a D1 binding and the schema applied", async () => {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM trails").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
