import { SHARED_OWNER, type Difficulty, type IndexState, type Status, type Trail } from "../domain/types";

const COLS = [
  "id", "owner", "name", "area", "trailhead", "route_type", "distance_min_mi", "distance_max_mi",
  "gain_min_ft", "gain_max_ft", "difficulty", "difficulty_note", "tags", "description", "status",
  "closed_until", "status_note", "status_checked", "source_urls", "index_state", "indexed_at",
].join(", ");

const UPDATABLE = COLS.split(", ").filter((c) => c !== "id" && c !== "owner");
const CHUNK = 90; // D1 allows 100 bound parameters; we also bind the owner
const BATCH = 50; // statements per db.batch() call

type Row = Record<string, unknown>;

function fromRow(r: Row): Trail {
  return {
    id: r.id as string,
    owner: r.owner as string,
    name: r.name as string,
    area: r.area as string,
    trailhead: r.trailhead as string,
    routeType: r.route_type as string,
    distanceMinMi: r.distance_min_mi as number,
    distanceMaxMi: r.distance_max_mi as number,
    gainMinFt: (r.gain_min_ft as number | null) ?? null,
    gainMaxFt: (r.gain_max_ft as number | null) ?? null,
    difficulty: r.difficulty as Difficulty,
    difficultyNote: (r.difficulty_note as string | null) ?? null,
    tags: JSON.parse(r.tags as string) as string[],
    description: r.description as string,
    status: r.status as Status,
    closedUntil: (r.closed_until as string | null) ?? null,
    statusNote: (r.status_note as string | null) ?? null,
    statusChecked: r.status_checked as string,
    sourceUrls: JSON.parse(r.source_urls as string) as string[],
    indexState: r.index_state as IndexState,
    indexedAt: (r.indexed_at as string | null) ?? null,
  };
}

function toValues(t: Trail): unknown[] {
  return [
    t.id, t.owner, t.name, t.area, t.trailhead, t.routeType, t.distanceMinMi, t.distanceMaxMi,
    t.gainMinFt, t.gainMaxFt, t.difficulty, t.difficultyNote, JSON.stringify(t.tags), t.description,
    t.status, t.closedUntil, t.statusNote, t.statusChecked, JSON.stringify(t.sourceUrls),
    t.indexState, t.indexedAt,
  ];
}

export class TrailsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * Returns false when nothing was written: the id exists under a different owner, or (with
   * maxOwned) the owner is at the cap and this would be a new row. The cap check and the insert
   * are one SQL statement, so concurrent adds cannot overshoot the cap.
   */
  async upsert(t: Trail, opts: { maxOwned?: number } = {}): Promise<boolean> {
    const res = await this.upsertStatement(t, opts).run();
    return res.meta.changes > 0;
  }

  private upsertStatement(t: Trail, opts: { maxOwned?: number } = {}): D1PreparedStatement {
    const placeholders = COLS.split(", ").map(() => "?").join(", ");
    const set = UPDATABLE.map((c) => `${c} = excluded.${c}`).join(", ");
    const conflict = `ON CONFLICT(id) DO UPDATE SET ${set} WHERE trails.owner = excluded.owner`;
    if (opts.maxOwned === undefined) {
      return this.db.prepare(`INSERT INTO trails (${COLS}) VALUES (${placeholders}) ${conflict}`).bind(...toValues(t));
    }
    return this.db
      .prepare(
        `INSERT INTO trails (${COLS}) SELECT ${placeholders}
         WHERE (SELECT COUNT(*) FROM trails WHERE owner = ?) < ? OR EXISTS (SELECT 1 FROM trails WHERE id = ?)
         ${conflict}`,
      )
      .bind(...toValues(t), t.owner, opts.maxOwned, t.id);
  }

  /** Many rows in a few round trips (db.batch), for seeding. */
  async upsertMany(trails: Trail[]): Promise<void> {
    for (let i = 0; i < trails.length; i += BATCH) {
      await this.db.batch(trails.slice(i, i + BATCH).map((t) => this.upsertStatement(t)));
    }
  }

  async getVisible(id: string, userId: string): Promise<Trail | null> {
    const row = await this.db
      .prepare(`SELECT ${COLS} FROM trails WHERE id = ? AND owner IN (?, ?)`)
      .bind(id, SHARED_OWNER, userId)
      .first<Row>();
    return row ? fromRow(row) : null;
  }

  async getVisibleByIds(ids: string[], userId: string): Promise<Trail[]> {
    const out: Trail[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const marks = chunk.map(() => "?").join(", ");
      const { results } = await this.db
        .prepare(`SELECT ${COLS} FROM trails WHERE owner IN (?, ?) AND id IN (${marks})`)
        .bind(SHARED_OWNER, userId, ...chunk)
        .all<Row>();
      out.push(...results.map(fromRow));
    }
    return out;
  }

  async findVisibleByName(name: string, userId: string): Promise<Trail[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLS} FROM trails WHERE owner IN (?, ?) AND name = ? COLLATE NOCASE`)
      .bind(SHARED_OWNER, userId, name)
      .all<Row>();
    return results.map(fromRow);
  }

  async countOwned(userId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM trails WHERE owner = ?")
      .bind(userId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async deleteOwned(id: string, userId: string): Promise<boolean> {
    if (userId === SHARED_OWNER) return false;
    const res = await this.db.prepare("DELETE FROM trails WHERE id = ? AND owner = ?").bind(id, userId).run();
    return res.meta.changes > 0;
  }

  async setIndexState(id: string, state: IndexState, now: Date): Promise<void> {
    await this.db
      .prepare("UPDATE trails SET index_state = ?, indexed_at = ? WHERE id = ?")
      .bind(state, state === "indexed" ? now.toISOString() : null, id)
      .run();
  }

  async setIndexStateMany(ids: string[], state: IndexState, now: Date): Promise<void> {
    const at = state === "indexed" ? now.toISOString() : null;
    for (let i = 0; i < ids.length; i += BATCH) {
      await this.db.batch(
        ids
          .slice(i, i + BATCH)
          .map((id) => this.db.prepare("UPDATE trails SET index_state = ?, indexed_at = ? WHERE id = ?").bind(state, at, id)),
      );
    }
  }

  /** Rows still needing an embedding (pending first, then failed), at most `limit`. */
  async listForReindex(limit: number): Promise<Trail[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLS} FROM trails WHERE index_state != 'indexed'
         ORDER BY CASE index_state WHEN 'pending' THEN 0 ELSE 1 END, id LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return results.map(fromRow);
  }

  async countUnindexed(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM trails WHERE index_state != 'indexed'").first<{ n: number }>();
    return row?.n ?? 0;
  }

  async markAllPending(): Promise<void> {
    await this.db.prepare("UPDATE trails SET index_state = 'pending', indexed_at = NULL").run();
  }
}
