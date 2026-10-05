CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  goal_type TEXT DEFAULT 'maintain' CHECK (goal_type IN ('lose','maintain','gain')),
  target_kcal INTEGER DEFAULT 2000,
  protein_target_g INTEGER DEFAULT 120,
  current_weight_kg REAL,
  target_weight_kg REAL,
  created_at INTEGER NOT NULL,
  UNIQUE(channel, channel_user_id)
);

CREATE TABLE IF NOT EXISTS meals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  raw_text TEXT DEFAULT '',
  photo_key TEXT,
  kcal INTEGER NOT NULL DEFAULT 0,
  protein_g REAL NOT NULL DEFAULT 0,
  carbs_g REAL NOT NULL DEFAULT 0,
  fat_g REAL NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meals_user_time ON meals(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS weights (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight_kg REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);
