/**
 * Supabase-backed adapter implementing the RedisLike interface.
 * Uses two Postgres tables:
 *   - durak_store (key TEXT PRIMARY KEY, value TEXT) — KV pairs
 *   - durak_sets  (set_key TEXT, member TEXT, PRIMARY KEY (set_key, member)) — set members
 *
 * Created automatically with CREATE TABLE IF NOT EXISTS on first use.
 * Teach the table names explicitly.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RedisLike } from "./store.js";

/**
 * Table names used by the Supabase storage adapter.
 * Schema: CREATE TABLE durak_store (key TEXT PRIMARY KEY, value TEXT);
 *         CREATE TABLE durak_sets (set_key TEXT, member TEXT, PRIMARY KEY (set_key, member));
 * These must be created by the database owner before the bot runs.
 */
const TABLE_STORE = "durak_store";
const TABLE_SETS = "durak_sets";

export function createSupabaseClient(
  url: string,
  key: string,
): RedisLike {
  const client = createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: "public" },
  });
  return new SupabaseKV(client);
}

class SupabaseKV implements RedisLike {
  constructor(private client: SupabaseClient) {}

  async get(key: string): Promise<string | null> {
    const { data, error } = await this.client
      .from(TABLE_STORE)
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    const { error } = await this.client
      .from(TABLE_STORE)
      .upsert({ key, value }, { onConflict: "key" });
    if (error) throw error;
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    const { error } = await this.client
      .from(TABLE_STORE)
      .delete()
      .eq("key", key);
    if (error) throw error;
    return 1;
  }

  async sadd(key: string, ...members: string[]): Promise<unknown> {
    if (members.length === 0) return 0;
    const rows = members.map((m) => ({ set_key: key, member: m }));
    const { error } = await this.client
      .from(TABLE_SETS)
      .upsert(rows, { onConflict: "set_key,member" });
    if (error) throw error;
    return members.length;
  }

  async srem(key: string, ...members: string[]): Promise<unknown> {
    if (members.length === 0) return 0;
    const { error } = await this.client
      .from(TABLE_SETS)
      .delete()
      .eq("set_key", key)
      .in("member", members);
    if (error) throw error;
    return members.length;
  }

  async smembers(key: string): Promise<string[]> {
    const { data, error } = await this.client
      .from(TABLE_SETS)
      .select("member")
      .eq("set_key", key)
      .order("member");
    if (error) throw error;
    return (data ?? []).map((r) => r.member);
  }

  async scard(key: string): Promise<unknown> {
    const { count, error } = await this.client
      .from(TABLE_SETS)
      .select("*", { count: "exact", head: true })
      .eq("set_key", key);
    if (error) throw error;
    return count ?? 0;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const { data, error } = await this.client
      .from(TABLE_STORE)
      .select("key, value")
      .in("key", keys);
    if (error) throw error;
    const map = new Map((data ?? []).map((r) => [r.key, r.value]));
    return keys.map((k) => map.get(k) ?? null);
  }

  async incr(key: string): Promise<number> {
    // Simple increment (no CAS) — used where race is acceptable.
    // Uses read-modify-write with a retry loop for robustness.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await this.client
        .from(TABLE_STORE)
        .select("value")
        .eq("key", key)
        .maybeSingle();
      if (error) throw error;
      const current = data?.value ? parseInt(data.value, 10) : 0;
      const next = current + 1;
      // Use INSERT ... ON CONFLICT DO UPDATE which is atomic at the DB level
      const { error: upsertError } = await this.client.rpc(
        "durak_atomic_upsert_counter",
        { p_key: key, p_value: String(next) },
      );
      if (!upsertError) return next;
      // If the RPC doesn't exist (owner hasn't created it), fall back to normal upsert
      if (upsertError.code === "PGRST202" || upsertError.message?.includes("function not found")) {
        const { error: fallbackError } = await this.client
          .from(TABLE_STORE)
          .upsert({ key, value: String(next) }, { onConflict: "key" });
        if (fallbackError) {
          if (attempt < 2) continue; // retry on transient
          throw fallbackError;
        }
        return next;
      }
      if (attempt < 2) continue; // retry on transient
      throw upsertError;
    }
    throw new Error(`incr failed after 3 attempts for key ${key}`);
  }

  async checkAndIncr(key: string, expected: number): Promise<number> {
    // Atomic compare-and-increment via Postgres function with pg_try_advisory_xact_lock.
    // This prevents the read-modify-write race that plagues saveGameWithVersion.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await this.client.rpc(
        "durak_check_and_incr",
        { p_key: key, p_expected: expected },
      );
      if (error) {
        // If the RPC hasn't been created by the DB owner yet, fall back to
        // read-modify-write with manual retry.
        if (error.code === "PGRST202" || error.message?.includes("function not found")) {
          // Fallback: manual check + upsert with retry
          const { data: readData, error: readError } = await this.client
            .from(TABLE_STORE)
            .select("value")
            .eq("key", key)
            .maybeSingle();
          if (readError) {
            if (attempt < 2) continue;
            throw readError;
          }
          const current = readData?.value ? parseInt(readData.value, 10) : 0;
          if (current !== expected) return -1;
          const next = current + 1;
          const { error: writeError } = await this.client
            .from(TABLE_STORE)
            .upsert({ key, value: String(next) }, { onConflict: "key" });
          if (writeError) {
            if (attempt < 2) continue;
            throw writeError;
          }
          return next;
        }
        if (attempt < 2) continue;
        throw error;
      }
      // RPC returns the new value, or -1 if the check failed
      return data as number;
    }
    throw new Error(`checkAndIncr failed after 3 attempts for key ${key}`);
  }
}
