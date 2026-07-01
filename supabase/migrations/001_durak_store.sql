-- Durak bot — Supabase database schema
-- Run this migration in your Supabase project SQL editor.
--
-- Tables for persistent game state storage. Maps the Redis-like key-value + set
-- operations that the bot's store layer uses onto PostgreSQL tables so the bot
-- runs against Supabase in production with zero code changes.

-- Key-value store (replaces Redis get/set/del for individual keys).
CREATE TABLE IF NOT EXISTS durak_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Set members (replaces Redis sadd/srem/smembers/scard for set operations).
CREATE TABLE IF NOT EXISTS durak_set_members (
  set_key TEXT  NOT NULL,
  member  TEXT  NOT NULL,
  PRIMARY KEY (set_key, member)
);

-- Index for fast lookups by set_key.
CREATE INDEX IF NOT EXISTS idx_durak_set_members_set_key
  ON durak_set_members (set_key);
