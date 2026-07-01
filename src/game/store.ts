/**
 * Persistent game store — Supabase-backed durable storage for game state, player
 * hands, and action audit log. Uses explicit index-based queries (never sequential
 * scans pretending to be key lookups). Falls back to in-memory Map when
 * SUPABASE_URL is not set (dev/testing).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Game, Player, Action } from "./types.js";

// ---- Database row shapes (Supabase maps these from PostgreSQL) ----

interface GameRow {
  game_code: string;
  chat_id: number;
  status: string;
  trump_suit: string;
  trump_card: unknown;
  deck: unknown;
  discard: unknown;
  table_cards: unknown;
  current_attacker_index: number;
  current_defender_index: number;
  player_count: number;
  attacker_ids: unknown;
  passed_ids: unknown;
  round_over: boolean;
  created_at: number;
}

interface PlayerRow {
  telegram_id: number;
  game_code: string;
  seat_index: number;
  hand: unknown;
  status: string;
  joined_at: number;
}

interface ActionRow {
  id?: number;
  player_id: number;
  game_code: string;
  action_type: string;
  timestamp: number;
}

// ---- In-memory fallback (only when Supabase is not configured) ----

class InMemoryStore {
  private games = new Map<string, Game>();
  private players = new Map<number, Player>();
  private playerGame = new Map<number, string>();
  private gamePlayers = new Map<string, Set<number>>();
  private actions = new Map<string, Action[]>();

  // Games
  saveGame(game: Game): void {
    this.games.set(game.game_code, game);
  }
  getGame(code: string): Game | null {
    return this.games.get(code) ?? null;
  }
  deleteGame(code: string): void {
    this.games.delete(code);
    this.gamePlayers.delete(code);
    this.actions.delete(code);
  }

  // Players
  savePlayer(player: Player): void {
    this.players.set(player.telegram_id, player);
    this.playerGame.set(player.telegram_id, player.game_code);
    let set = this.gamePlayers.get(player.game_code);
    if (!set) { set = new Set(); this.gamePlayers.set(player.game_code, set); }
    set.add(player.telegram_id);
  }
  getPlayer(telegramId: number): Player | null {
    return this.players.get(telegramId) ?? null;
  }
  getPlayerGameCode(telegramId: number): string | null {
    return this.playerGame.get(telegramId) ?? null;
  }
  getGamePlayers(code: string): Player[] {
    const ids = this.gamePlayers.get(code);
    if (!ids || ids.size === 0) return [];
    const result: Player[] = [];
    for (const id of ids) {
      const p = this.players.get(id);
      if (p) result.push(p);
    }
    return result;
  }
  getGamePlayerCount(code: string): number {
    return this.gamePlayers.get(code)?.size ?? 0;
  }
  removePlayer(telegramId: number, gameCode: string): void {
    this.players.delete(telegramId);
    this.playerGame.delete(telegramId);
    this.gamePlayers.get(gameCode)?.delete(telegramId);
  }
  removeAllPlayers(gameCode: string): void {
    const ids = this.gamePlayers.get(gameCode);
    if (ids) {
      for (const id of ids) {
        this.players.delete(id);
        this.playerGame.delete(id);
      }
    }
    this.gamePlayers.delete(gameCode);
  }

  // Actions
  saveAction(action: Action): void {
    const list = this.actions.get(action.game_code) ?? [];
    list.push(action);
    this.actions.set(action.game_code, list);
  }

  // Active game codes (for sweeper-style operations)
  getActiveGameCodes(): string[] {
    const codes: string[] = [];
    for (const [code, game] of this.games) {
      if (game.status === "lobby" || game.status === "playing") {
        codes.push(code);
      }
    }
    return codes;
  }
}

// ---- Supabase client management ----

let _client: SupabaseClient | null = null;
let _fallback: InMemoryStore | null = null;

function fallback(): InMemoryStore {
  if (!_fallback) _fallback = new InMemoryStore();
  return _fallback;
}

function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_KEY are required");
  }
  _client = createClient(url, key, {
    db: { schema: "public" },
  });
  return _client;
}

function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
}

// ---- Helpers: convert between domain types and DB rows ----

function gameToRow(game: Game): GameRow {
  return {
    game_code: game.game_code,
    chat_id: game.chat_id,
    status: game.status,
    trump_suit: game.trump_suit,
    trump_card: game.trump_card,
    deck: game.deck,
    discard: game.discard,
    table_cards: game.table_cards,
    current_attacker_index: game.current_attacker_index,
    current_defender_index: game.current_defender_index,
    player_count: game.player_count,
    attacker_ids: game.attacker_ids,
    passed_ids: game.passed_ids,
    round_over: game.round_over,
    created_at: game.created_at,
  };
}

function rowToGame(row: GameRow): Game {
  return {
    game_code: row.game_code,
    chat_id: row.chat_id,
    status: row.status as Game["status"],
    trump_suit: row.trump_suit as Game["trump_suit"],
    trump_card: row.trump_card as Game["trump_card"],
    deck: row.deck as Game["deck"],
    discard: row.discard as Game["discard"],
    table_cards: row.table_cards as Game["table_cards"],
    current_attacker_index: row.current_attacker_index,
    current_defender_index: row.current_defender_index,
    player_count: row.player_count,
    attacker_ids: row.attacker_ids as Game["attacker_ids"],
    passed_ids: row.passed_ids as Game["passed_ids"],
    round_over: row.round_over,
    created_at: row.created_at,
  };
}

function playerToRow(player: Player): PlayerRow {
  return {
    telegram_id: player.telegram_id,
    game_code: player.game_code,
    seat_index: player.seat_index,
    hand: player.hand,
    status: player.status,
    joined_at: player.joined_at,
  };
}

function rowToPlayer(row: PlayerRow): Player {
  return {
    telegram_id: row.telegram_id,
    game_code: row.game_code,
    seat_index: row.seat_index,
    hand: row.hand as Player["hand"],
    status: row.status as Player["status"],
    joined_at: row.joined_at,
  };
}

// ---- Public Store API ----

export async function saveGame(game: Game): Promise<void> {
  if (!isSupabaseConfigured()) {
    fallback().saveGame(game);
    return;
  }
  const sb = getSupabase();
  const { error } = await sb.from("games").upsert(gameToRow(game));
  if (error) throw new Error(`saveGame failed: ${error.message}`);
}

export async function getGame(code: string): Promise<Game | null> {
  if (!isSupabaseConfigured()) {
    return fallback().getGame(code);
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("games")
    .select("*")
    .eq("game_code", code)
    .maybeSingle();
  if (error) throw new Error(`getGame failed: ${error.message}`);
  return data ? rowToGame(data as GameRow) : null;
}

export async function deleteGame(code: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    fallback().deleteGame(code);
    return;
  }
  const sb = getSupabase();
  // Delete related rows
  await sb.from("actions").delete().eq("game_code", code);
  await sb.from("players").delete().eq("game_code", code);
  const { error } = await sb.from("games").delete().eq("game_code", code);
  if (error) throw new Error(`deleteGame failed: ${error.message}`);
}

export async function savePlayer(player: Player): Promise<void> {
  if (!isSupabaseConfigured()) {
    fallback().savePlayer(player);
    return;
  }
  const sb = getSupabase();
  const { error } = await sb.from("players").upsert(playerToRow(player));
  if (error) throw new Error(`savePlayer failed: ${error.message}`);
}

export async function getPlayer(telegramId: number): Promise<Player | null> {
  if (!isSupabaseConfigured()) {
    return fallback().getPlayer(telegramId);
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("players")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw new Error(`getPlayer failed: ${error.message}`);
  return data ? rowToPlayer(data as PlayerRow) : null;
}

export async function getPlayerGameCode(telegramId: number): Promise<string | null> {
  const player = await getPlayer(telegramId);
  return player?.game_code ?? null;
}

export async function getGamePlayers(code: string): Promise<Player[]> {
  if (!isSupabaseConfigured()) {
    return fallback().getGamePlayers(code);
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("players")
    .select("*")
    .eq("game_code", code)
    .order("seat_index", { ascending: true });
  if (error) throw new Error(`getGamePlayers failed: ${error.message}`);
  return (data as PlayerRow[]).map(rowToPlayer);
}

export async function getGamePlayerCount(code: string): Promise<number> {
  if (!isSupabaseConfigured()) {
    return fallback().getGamePlayerCount(code);
  }
  const sb = getSupabase();
  const { count, error } = await sb
    .from("players")
    .select("*", { count: "exact", head: true })
    .eq("game_code", code);
  if (error) throw new Error(`getGamePlayerCount failed: ${error.message}`);
  return count ?? 0;
}

export async function removePlayer(telegramId: number, gameCode: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    fallback().removePlayer(telegramId, gameCode);
    return;
  }
  const sb = getSupabase();
  const { error } = await sb
    .from("players")
    .delete()
    .eq("telegram_id", telegramId)
    .eq("game_code", gameCode);
  if (error) throw new Error(`removePlayer failed: ${error.message}`);
}

export async function removeAllPlayers(gameCode: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    fallback().removeAllPlayers(gameCode);
    return;
  }
  const sb = getSupabase();
  const { error } = await sb
    .from("players")
    .delete()
    .eq("game_code", gameCode);
  if (error) throw new Error(`removeAllPlayers failed: ${error.message}`);
}

export async function saveAction(action: Action): Promise<void> {
  if (!isSupabaseConfigured()) {
    fallback().saveAction(action);
    return;
  }
  const sb = getSupabase();
  const { error } = await sb.from("actions").insert({
    player_id: action.player_id,
    game_code: action.game_code,
    action_type: action.action_type,
    timestamp: action.timestamp,
  } as ActionRow);
  if (error) throw new Error(`saveAction failed: ${error.message}`);
}

export async function getActiveGameCodes(): Promise<string[]> {
  if (!isSupabaseConfigured()) {
    return fallback().getActiveGameCodes();
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("games")
    .select("game_code")
    .in("status", ["lobby", "playing"]);
  if (error) throw new Error(`getActiveGameCodes failed: ${error.message}`);
  return (data as { game_code: string }[]).map((r) => r.game_code);
}

/** Reset the client (test-only). */
export function resetGameStoreClient(): void {
  _client = null;
  _fallback = null;
}

/** Override the Supabase client (test-only). */
export function setGameStoreClient(client: SupabaseClient): void {
  _client = client;
}