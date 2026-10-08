import initSql from "../../migrations/0001_init.sql?raw";
import addressSql from "../../migrations/0002_add_address.sql?raw";

/** Applies every migration in order, the same way `wrangler d1 migrations apply` would. */
export async function applySchema(db: D1Database): Promise<void> {
  for (const migration of [initSql, addressSql]) {
    const statements = migration
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sql of statements) {
      await db.prepare(sql).run();
    }
  }
}

export async function clearTrails(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM trails").run();
}
