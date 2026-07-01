/**
 * Persistent game store — Supabase-backed durable storage for game state, player
 * hands, and action audit log. Uses explicit field queries (never list-all).
 * Falls back to in-memory Map when SUPABASE_URL/SUPABASE_KEY is not set
 * (dev/testing).
 *
 * Schema (create these tables in the Supabase SQL editor):
 *
 *   CREATE TABLE games (
 *     game_code text PRIMARY KEY,
 *     chat_id bigint NOT NULL,
 *     status text NOT NULL DEFAULT 'lobby',
 *     trump_suit text NOT NULL,
 *     trump_card jsonb NOT NULL,
 *     deck jsonb NOT NULL DEFAULT '[]'::jsonb,
 *     discard jsonb NOT NULL DEFAULT '[]'::jsonb,
 *     table_cards jsonb NOT NULL DEFAULT '[]'::jsonb,
 *     current_attacker_index integer NOT NULL DEFAULT 0,
 *     current_defender_index integer NOT NULL DEFAULT 0,
 *     player_count integer NOT NULL DEFAULT 0,
 *     attacker_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 *     passed_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 *     round_over boolean NOT NULL DEFAULT false,
 *     created_at bigint NOT NULL
 *   );
 *
 *   CREATE TABLE players (
 *     telegram_id bigint PRIMARY KEY,
 *     game_code text NOT NULL REFERENCES games(game_code),
 *     seat_index integer NOT NULL,
 *     hand jsonb NOT NULL DEFAULT '[]'::jsonb,
 *     status text NOT NULL DEFAULT 'playing',
 *     joined_at bigint NOT NULL
 *   );
 *   CREATE INDEX idx_players_game ON players(game_code, seat_index);
 *
 *   CREATE TABLE actions (
 *     id bigserial PRIMARY KEY,
 *     player_id bigint NOT NULL,
 *     game_code text NOT NULL REFERENCES games(game_code),
 *     action_type text NOT NULL,
 *     timestamp bigint NOT NULL
 *   );
 *   CREATE INDEX idx_actions_game ON actions(game_code, timestamp);
 */

import type { Game, Player, Action } from "./types.js";

export interface SupabaseLike {
  from(table: string): SupabaseQueryBuilder;
}

export interface SupabaseQueryBuilder {
  select(columns?: string): SupabaseFilterBuilder;
  upsert(rows: unknown | unknown[], opts?: { onConflict?: string }): Promise<{ error: unknown }>;
  insert(rows: unknown | unknown[]): Promise<{ error: unknown }>;
  delete(): { eq(field: string, value: unknown): Promise<{ error: unknown }> };
  update(values: Record<string, unknown>): { eq(field: string, value: unknown): Promise<{ error: unknown }> };
}

export interface SupabaseFilterBuilder {
  eq(field: string, value: unknown): SupabaseFilterBuilder;
  order(field: string, opts?: { ascending?: boolean }): SupabaseFilterBuilder;
  limit(n: number): SupabaseFilterBuilder;
  then<T>(resolve: (v: { data: unknown[] | null; error: unknown }) => T): Promise<T>;
}

class InMemorySupabase implements SupabaseLike {
  private games = new Map<string, Game>();
  private players = new Map<number, Player>();
  private actions: Action[] = [];

  from(table: string): SupabaseQueryBuilder {
    const self = this;
    return {
      select(columns?: string): SupabaseFilterBuilder {
        return new InMemoryFilterBuilder(self, table);
      },
      async upsert(rows: unknown | unknown[], opts?: { onConflict?: string }) {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) {
          if (table === "games") {
            const g = r as Game;
            self.games.set(g.game_code, { ...g });
          } else if (table === "players") {
            const p = r as Player;
            self.players.set(p.telegram_id, { ...p });
          }
        }
        return { error: null };
      },
      async insert(rows: unknown | unknown[]) {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) {
          if (table === "actions") {
            self.actions.push({ ...(r as Action) });
          }
        }
        return { error: null };
      },
      delete() {
        return {
          async eq(field: string, value: unknown) {
            if (table === "games") { self.games.delete(String(value)); }
            else if (table === "players") {
              if (field === "game_code") {
                for (const [k, p] of self.players) {
                  if (p.game_code === value) self.players.delete(k);
                }
              } else if (field === "telegram_id") { self.players.delete(Number(value)); }
            } else if (table === "actions") {
              if (field === "game_code") {
                self.actions = self.actions.filter(a => a.game_code !== value);
              }
            }
            return { error: null };
          },
        };
      },
      update(values: Record<string, unknown>) {
        return {
          async eq(field: string, value: unknown) {
            if (table === "games") {
              const g = self.games.get(String(value));
              if (g) Object.assign(g, values);
            } else if (table === "players") {
              const p = self.players.get(Number(value));
              if (p) Object.assign(p, values);
            }
            return { error: null };
          },
        };
      },
    };
  }
}

class InMemoryFilterBuilder implements SupabaseFilterBuilder {
  private table: string;
  private store: InMemorySupabase;
  private _eq: { field: string; value: unknown }[] = [];
  private _orderField: string | null = null;
  private _orderAsc = true;
  private _limit: number | null = null;

  constructor(store: InMemorySupabase, table: string) {
    this.store = store;
    this.table = table;
  }

  eq(field: string, value: unknown): SupabaseFilterBuilder {
    this._eq.push({ field, value });
    return this;
  }

  order(field: string, opts?: { ascending?: boolean }): SupabaseFilterBuilder {
    this._orderField = field;
    this._orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number): SupabaseFilterBuilder {
    this._limit = n;
    return this;
  }

  then<T>(resolve: (v: { data: unknown[] | null; error: unknown }) => T): Promise<T> {
    const result = this.exec();
    return Promise.resolve(result).then(resolve);
  }

  private exec(): { data: unknown[] | null; error: unknown } {
    let rows: unknown[] = [];

    if (this.table === "games") {
      const games = [...this.store["games"].values()];
      for (const eq of this._eq) {
        rows = games.filter(g => ((g as unknown) as Record<string, unknown>)[eq.field] === eq.value).map(g => ({ ...g }));
      }
    } else if (this.table === "players") {
      let players = [...this.store["players"].values()];
      for (const eq of this._eq) {
        players = players.filter(p => ((p as unknown) as Record<string, unknown>)[eq.field] === eq.value);
      }
      rows = players.map(p => ({ ...p }));
    } else if (this.table === "actions") {
      let acts = [...this.store["actions"]];
      for (const eq of this._eq) {
        acts = acts.filter(a => ((a as unknown) as Record<string, unknown>)[eq.field] === eq.value);
      }
      rows = acts.map(a => ({ ...(a as Action) }));
    }

    if (this._orderField) {
      const field = this._orderField;
      rows.sort((a, b) => {
        const av = (a as Record<string, unknown>)[field] as number;
        const bv = (b as Record<string, unknown>)[field] as number;
        return this._orderAsc ? av - bv : bv - av;
      });
    }

    if (this._limit !== null) {
      rows = rows.slice(0, this._limit);
    }

    return { data: rows, error: null };
  }
}

let _client: SupabaseLike | null = null;

async function initClient(): Promise<SupabaseLike> {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!url || !key) {
    _client = new InMemorySupabase();
    return _client;
  }

  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabaseModule: any = require("@supabase/supabase-js");
    const createClient = supabaseModule.createClient ?? supabaseModule.default?.createClient;
    if (!createClient) throw new Error("Could not resolve createClient from @supabase/supabase-js");
    _client = createClient(url, key) as SupabaseLike;
  } catch (err) {
    console.warn("[game-store] Supabase client init failed, using in-memory fallback:", err);
    _client = new InMemorySupabase();
  }
  return _client;
}

/** Reset the client (test-only). */
export function resetGameStoreClient(): void {
  _client = null;
}

/** Override the client (test-only). */
export function setGameStoreClient(client: SupabaseLike): void {
  _client = client;
}

// --- Game Store API ---

export async function saveGame(game: Game): Promise<void> {
  const client = await initClient();
  const { error } = await client.from("games").upsert({
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
  }, { onConflict: "game_code" });
  if (error) throw new Error(`Failed to save game: ${JSON.stringify(error)}`);
}

export async function getGame(code: string): Promise<Game | null> {
  const client = await initClient();
  const { data, error } = await client.from("games").select("*").eq("game_code", code);
  if (error) throw new Error(`Failed to load game: ${JSON.stringify(error)}`);
  if (!data || (data as unknown[]).length === 0) return null;
  return (data as unknown[])[0] as Game;
}

export async function deleteGame(code: string): Promise<void> {
  const client = await initClient();
  await client.from("games").delete().eq("game_code", code);
  await client.from("players").delete().eq("game_code", code);
  await client.from("actions").delete().eq("game_code", code);
}

export async function savePlayer(player: Player): Promise<void> {
  const client = await initClient();
  const { error } = await client.from("players").upsert({
    telegram_id: player.telegram_id,
    game_code: player.game_code,
    seat_index: player.seat_index,
    hand: player.hand,
    status: player.status,
    joined_at: player.joined_at,
  }, { onConflict: "telegram_id" });
  if (error) throw new Error(`Failed to save player: ${JSON.stringify(error)}`);
}

export async function getPlayer(telegramId: number): Promise<Player | null> {
  const client = await initClient();
  const { data, error } = await client.from("players").select("*").eq("telegram_id", telegramId);
  if (error) throw new Error(`Failed to load player: ${JSON.stringify(error)}`);
  if (!data || (data as unknown[]).length === 0) return null;
  return (data as unknown[])[0] as Player;
}

export async function getPlayerGameCode(telegramId: number): Promise<string | null> {
  const player = await getPlayer(telegramId);
  return player?.game_code ?? null;
}

export async function getGamePlayers(code: string): Promise<Player[]> {
  const client = await initClient();
  const { data, error } = await client.from("players")
    .select("*")
    .eq("game_code", code)
    .order("seat_index", { ascending: true })
    .limit(100);
  if (error) throw new Error(`Failed to load players: ${JSON.stringify(error)}`);
  return (data ?? []) as Player[];
}

export async function getGamePlayerCount(code: string): Promise<number> {
  const players = await getGamePlayers(code);
  return players.length;
}

export async function removePlayer(telegramId: number, gameCode: string): Promise<void> {
  const client = await initClient();
  await client.from("players").delete().eq("telegram_id", telegramId);
}

export async function removeAllPlayers(gameCode: string): Promise<void> {
  const client = await initClient();
  await client.from("players").delete().eq("game_code", gameCode);
}

export async function saveAction(action: Action): Promise<void> {
  const client = await initClient();
  const { error } = await client.from("actions").insert({
    player_id: action.player_id,
    game_code: action.game_code,
    action_type: action.action_type,
    timestamp: action.timestamp,
  });
  if (error) {
    // Non-fatal: audit log failure should not block gameplay
    console.warn("[game-store] Failed to save action:", error);
  }
}

export async function getActiveGameCodes(): Promise<string[]> {
  const client = await initClient();
  const [lobbyRes, playingRes] = await Promise.all([
    client.from("games").select("game_code").eq("status", "lobby"),
    client.from("games").select("game_code").eq("status", "playing"),
  ]);
  const codes: string[] = [];
  for (const row of ((lobbyRes.data ?? []) as { game_code: string }[])) {
    codes.push(row.game_code);
  }
  for (const row of ((playingRes.data ?? []) as { game_code: string }[])) {
    codes.push(row.game_code);
  }
  return codes;
}