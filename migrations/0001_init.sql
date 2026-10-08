CREATE TABLE IF NOT EXISTS trails (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  area TEXT NOT NULL,
  trailhead TEXT NOT NULL,
  route_type TEXT NOT NULL,
  distance_min_mi REAL NOT NULL,
  distance_max_mi REAL NOT NULL,
  gain_min_ft INTEGER,
  gain_max_ft INTEGER,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','moderate','hard')),
  difficulty_note TEXT,
  tags TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed','verify')),
  closed_until TEXT,
  status_note TEXT,
  status_checked TEXT NOT NULL,
  source_urls TEXT NOT NULL,
  index_state TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending','indexed','failed')),
  indexed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trails_owner ON trails(owner);
CREATE INDEX IF NOT EXISTS idx_trails_owner_name ON trails(owner, name COLLATE NOCASE);
