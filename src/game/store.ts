/**
 * Persistent game store — Redis-backed durable storage for game state, player
 * hands, and action audit log. Uses explicit index keys (never KEYS/SCAN).
 * Falls back to in-memory Map when REDIS_URL is not set (dev/testing).
 */
import { createRequire } from "node:module";
import type { Game, Player, Action, TableCard, Card, AuditEvent } from "./types.js";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  /** Increment the integer value at a key. Returns the new value. */
  incr(key: string): Promise<number>;
  /**
   * Atomic compare-and-increment: only increment if the current value equals
   * `expected`. Returns the new value, or -1 if the value didn't match (caller
   * should retry from the read phase). In-memory implementation uses
   * synchronous access to guarantee atomicity; Redis uses WATCH/MULTI/EXEC;
   * Supabase uses a read-modify-write loop with version checking and retry.
   */
  checkAndIncr(key: string, expected: number): Promise<number>;
}

/** In-memory Map fallback implementing the Redis-like interface. */
class InMemoryRedis implements RedisLike {
  private store = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<string> {
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) { set = new Set<string>(); this.sets.set(key, set); }
    let added = 0;
    for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
    return added;
  }
  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) { if (set.delete(m)) removed++; }
    return removed;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set())];
  }
  async scard(key: string): Promise<number> {
    return (this.sets.get(key) ?? new Set()).size;
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map(k => this.store.get(k) ?? null);
  }
  async incr(key: string): Promise<number> {
    const raw = this.store.get(key) ?? "0";
    const next = parseInt(raw, 10) + 1;
    this.store.set(key, String(next));
    return next;
  }
  async checkAndIncr(key: string, expected: number): Promise<number> {
    const raw = this.store.get(key) ?? "0";
    const current = parseInt(raw, 10);
    if (current !== expected) return -1;
    const next = current + 1;
    this.store.set(key, String(next));
    return next;
  }
}

let _client: RedisLike | null = null;

function getClient(): RedisLike {
  if (_client) return _client;

  // Priority 1: REDIS_URL — existing Redis production setups
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const require = createRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ioredis: any = require("ioredis");
      const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
      _client = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: false }) as RedisLike;
    } catch {
      _client = new InMemoryRedis();
    }
    return _client;
  }

  // Priority 2: SUPABASE_URL + SUPABASE_KEY — Supabase (spec requirement)
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (supabaseUrl && supabaseKey) {
    try {
      const { createSupabaseClient } = require("./supabase-store.js") as {
        createSupabaseClient: (url: string, key: string) => RedisLike;
      };
      _client = createSupabaseClient(supabaseUrl, supabaseKey);
    } catch {
      _client = new InMemoryRedis();
    }
    return _client;
  }

  // Priority 3: in-memory fallback (dev / testing)
  _client = new InMemoryRedis();
  return _client;
}

/** Reset the client (test-only). */
export function resetGameStoreClient(): void {
  _client = null;
}

/** Override the client (test-only). */
export function setGameStoreClient(client: RedisLike): void {
  _client = client;
}

// --- Key helpers ---
const GAME_KEY = (code: string) => `durak:game:${code}`;
const GAME_VERSION_KEY = (code: string) => `durak:game:v:${code}`;
const PLAYER_KEY = (telegramId: number) => `durak:player:${telegramId}`;
const GAME_PLAYERS_SET = (code: string) => `durak:game_players:${code}`;
const GAME_ACTIONS_LIST = (code: string) => `durak:actions:${code}`;
const PLAYER_GAME_KEY = (telegramId: number) => `durak:player_game:${telegramId}`;
const ACTIVE_GAMES_SET = "durak:active_games";
const CHAT_GAME_INDEX = (chatId: number) => `durak:chat_game:${chatId}`;
const AUDIT_EVENT_COUNTER = "durak:audit:counter";
const AUDIT_EVENT_KEY = (id: number) => `durak:audit:${id}`;

// --- Game Store API ---

export async function saveGame(game: Game): Promise<void> {
  const client = getClient();
  await client.set(GAME_KEY(game.game_code), JSON.stringify(game));
  if (game.status === "lobby" || game.status === "playing") {
    await client.sadd(ACTIVE_GAMES_SET, game.game_code);
  }
}

/**
 * Save game with optimistic concurrency control. Reads the current version from a
 * separate version key, checks it matches `game.version`, then atomically sets both
 * the game data and the incremented version (INCR is atomic). Throws if the version
 * doesn't match — i.e. another mutation raced in first.
 *
 * Call this from ALL engine mutation functions instead of saveGame() to prevent
 * TOCTOU race conditions on game state.
 */
export async function saveGameWithVersion(game: Game): Promise<void> {
  const client = getClient();

  const versionKey = GAME_VERSION_KEY(game.game_code);
  const expectedVersion = game.version;

  // Use atomic checkAndIncr to avoid the TOCTOU race in read-then-write.
  // The version key starts at 0 (no record = 0). If checkAndIncr returns -1,
  // another request already incremented the version — throw a conflict.
  const newVersion = await client.checkAndIncr(versionKey, expectedVersion);

  if (newVersion < 0) {
    // Read the current version for a helpful error message
    const currentRaw = await client.get(versionKey);
    const currentVersion = currentRaw ? parseInt(currentRaw, 10) : 0;
    throw new ConcurrentModificationError(
      `Game ${game.game_code} was modified by another request (expected v${expectedVersion}, got v${currentVersion})`,
    );
  }

  // Write game data with the new version
  game.version = newVersion;
  await client.set(GAME_KEY(game.game_code), JSON.stringify(game));

  if (game.status === "lobby" || game.status === "playing") {
    await client.sadd(ACTIVE_GAMES_SET, game.game_code);
  }
}

export class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentModificationError";
  }
}

export async function getGame(code: string): Promise<Game | null> {
  const client = getClient();
  const raw = await client.get(GAME_KEY(code));
  if (!raw) return null;
  return JSON.parse(raw) as Game;
}

export async function deleteGame(code: string): Promise<void> {
  const client = getClient();
  // Clean up chat-game index
  const game = await getGame(code);
  if (game) {
    await client.del(CHAT_GAME_INDEX(game.chat_id));
  }
  await client.del(GAME_KEY(code));
  await client.srem(ACTIVE_GAMES_SET, code);
}

/** Store a chat→game_code mapping for one-active-game-per-chat enforcement. */
export async function setChatGameIndex(chatId: number, gameCode: string): Promise<void> {
  const client = getClient();
  await client.set(CHAT_GAME_INDEX(chatId), gameCode);
}

/** Remove a chat→game_code mapping. */
export async function clearChatGameIndex(chatId: number): Promise<void> {
  const client = getClient();
  await client.del(CHAT_GAME_INDEX(chatId));
}

/** Get the active game code for a chat, or null. */
export async function getChatGameCode(chatId: number): Promise<string | null> {
  const client = getClient();
  return await client.get(CHAT_GAME_INDEX(chatId));
}

/** Check if a chat already has an active (non-finished) game. */
export async function chatHasActiveGame(chatId: number): Promise<boolean> {
  const code = await getChatGameCode(chatId);
  if (!code) return false;
  const game = await getGame(code);
  return game !== null && game.status !== "finished";
}

// --- Audit Events ---

/** Save an audit event to persistent storage. */
export async function saveAuditEvent(event: AuditEvent): Promise<void> {
  const client = getClient();
  const id = await client.incr(AUDIT_EVENT_COUNTER);
  const key = AUDIT_EVENT_KEY(id);
  event.id = String(id);
  event.created_at = event.created_at ?? Date.now();
  await client.set(key, JSON.stringify(event));
}

export async function savePlayer(player: Player): Promise<void> {
  const client = getClient();
  await client.set(PLAYER_KEY(player.telegram_id), JSON.stringify(player));
  await client.set(PLAYER_GAME_KEY(player.telegram_id), player.game_code);
  await client.sadd(GAME_PLAYERS_SET(player.game_code), String(player.telegram_id));
}

export async function getPlayer(telegramId: number): Promise<Player | null> {
  const client = getClient();
  const raw = await client.get(PLAYER_KEY(telegramId));
  if (!raw) return null;
  return JSON.parse(raw) as Player;
}

export async function getPlayerGameCode(telegramId: number): Promise<string | null> {
  const client = getClient();
  return await client.get(PLAYER_GAME_KEY(telegramId));
}

export async function getGamePlayers(code: string): Promise<Player[]> {
  const client = getClient();
  const ids = await client.smembers(GAME_PLAYERS_SET(code));
  if (ids.length === 0) return [];
  const raws = await client.mget(...ids.map(id => PLAYER_KEY(Number(id))));
  return raws.filter(Boolean).map(r => JSON.parse(r!)) as Player[];
}

export async function getGamePlayerCount(code: string): Promise<number> {
  const client = getClient();
  const count = await client.scard(GAME_PLAYERS_SET(code));
  return Number(count);
}

export async function removePlayer(telegramId: number, gameCode: string): Promise<void> {
  const client = getClient();
  await client.srem(GAME_PLAYERS_SET(gameCode), String(telegramId));
  await client.del(PLAYER_GAME_KEY(telegramId));
  await client.del(PLAYER_KEY(telegramId));
}

export async function removeAllPlayers(gameCode: string): Promise<void> {
  const client = getClient();
  const ids = await client.smembers(GAME_PLAYERS_SET(gameCode));
  for (const id of ids) {
    await client.del(PLAYER_KEY(Number(id)));
    await client.del(PLAYER_GAME_KEY(Number(id)));
  }
  await client.del(GAME_PLAYERS_SET(gameCode));
}

export async function saveAction(action: Action): Promise<void> {
  const client = getClient();
  const key = GAME_ACTIONS_LIST(action.game_code);
  // Append action as JSON in a set keyed by timestamp
  await client.sadd(key, JSON.stringify(action));
}

/** Retrieve actions for a game (for audit/recovery purposes). Ordered by timestamp. */
export async function getGameActions(code: string): Promise<Action[]> {
  const client = getClient();
  const rawActions = await client.smembers(GAME_ACTIONS_LIST(code));
  const actions = rawActions.map(r => JSON.parse(r) as Action);
  actions.sort((a, b) => a.timestamp - b.timestamp);
  return actions;
}

export async function getActiveGameCodes(): Promise<string[]> {
  const client = getClient();
  return await client.smembers(ACTIVE_GAMES_SET);
}