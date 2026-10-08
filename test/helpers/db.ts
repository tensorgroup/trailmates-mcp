import schemaSql from "../../migrations/0001_init.sql?raw";

export async function applySchema(db: D1Database): Promise<void> {
  const statements = schemaSql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}

export async function clearTrails(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM trails").run();
}
