-- Supabase database schema for Durak Telegram Bot
-- Run this in the Supabase SQL editor to set up tables and indexes.

-- Games table: one row per game (lobby, playing, finished)
CREATE TABLE IF NOT EXISTS games (
  game_code       TEXT PRIMARY KEY,
  chat_id         BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'lobby',
  trump_suit      TEXT,
  trump_card      JSONB,
  deck            JSONB DEFAULT '[]'::jsonb,
  discard         JSONB DEFAULT '[]'::jsonb,
  table_cards     JSONB DEFAULT '[]'::jsonb,
  current_attacker_index INTEGER DEFAULT 0,
  current_defender_index INTEGER DEFAULT 0,
  player_count    INTEGER DEFAULT 0,
  attacker_ids    JSONB DEFAULT '[]'::jsonb,
  passed_ids      JSONB DEFAULT '[]'::jsonb,
  round_over      BOOLEAN DEFAULT false,
  created_at      BIGINT NOT NULL
);

-- Players table: one row per player-active-game
CREATE TABLE IF NOT EXISTS players (
  telegram_id     BIGINT NOT NULL,
  game_code       TEXT NOT NULL REFERENCES games(game_code) ON DELETE CASCADE,
  seat_index      INTEGER NOT NULL,
  hand            JSONB DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'playing',
  joined_at       BIGINT NOT NULL,
  PRIMARY KEY (telegram_id, game_code)
);

-- Index for looking up all players in a game
CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_code);

-- Actions table: audit log for recovery
CREATE TABLE IF NOT EXISTS actions (
  id              BIGSERIAL PRIMARY KEY,
  player_id       BIGINT NOT NULL,
  game_code       TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  timestamp       BIGINT NOT NULL
);

-- Index for looking up actions by game
CREATE INDEX IF NOT EXISTS idx_actions_game ON actions(game_code);

-- Enable row-level security (RLS) but allow all operations (service key is used)
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on games"    ON games    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on players"  ON players  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on actions"  ON actions  FOR ALL USING (true) WITH CHECK (true);
