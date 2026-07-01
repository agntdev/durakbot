/**
 * Supabase-backed persistent storage for Durak game state, implementing the
 * RedisLike interface from store.ts so it's a drop-in replacement.
 *
 * Converts get/set/del to the durak_kv table and set operations to the
 * durak_set_members table. Uses @supabase/supabase-js with env variables:
 *   SUPABASE_URL    — project URL
 *   SUPABASE_KEY    — service-role key
 *
 * When no Supabase credentials are present the class falls through to a
 * "not available" state (caller uses in-memory instead).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RedisLike } from "./store.js";

let _client: SupabaseClient | null | undefined;

async function getClient(): Promise<SupabaseClient> {
  if (_client !== undefined) return _client!;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    _client = null;
    throw new Error("Supabase not configured — set SUPABASE_URL and SUPABASE_KEY");
  }

  try {
    const { createClient } = await import("@supabase/supabase-js");
    _client = createClient(url, key, {
      auth: { persistSession: false },
      db: { schema: "public" },
    });
    return _client;
  } catch {
    _client = null;
    throw new Error("Supabase not configured — @supabase/supabase-js could not be loaded");
  }
}

export class SupabaseStorage implements RedisLike {
  async get(key: string): Promise<string | null> {
    const client = await getClient();
    const { data, error } = await client
      .from("durak_kv")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) throw error;
    return (data as { value: string } | null)?.value ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    const client = await getClient();
    const { error } = await client
      .from("durak_kv")
      .upsert({ key, value }, { onConflict: "key" });

    if (error) throw error;
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    const client = await getClient();
    const { error } = await client
      .from("durak_kv")
      .delete()
      .eq("key", key);

    if (error) throw error;
    return 1;
  }

  async sadd(key: string, ...members: string[]): Promise<unknown> {
    const client = await getClient();
    const rows = members.map((member) => ({ set_key: key, member }));
    const { error } = await client
      .from("durak_set_members")
      .upsert(rows, { onConflict: "set_key,member" });

    if (error) throw error;
    return members.length;
  }

  async srem(key: string, ...members: string[]): Promise<unknown> {
    const client = await getClient();
    const { error } = await client
      .from("durak_set_members")
      .delete()
      .eq("set_key", key)
      .in("member", members);

    if (error) throw error;
    return members.length;
  }

  async smembers(key: string): Promise<string[]> {
    const client = await getClient();
    const { data, error } = await client
      .from("durak_set_members")
      .select("member")
      .eq("set_key", key);

    if (error) throw error;
    return ((data ?? []) as { member: string }[]).map((r) => r.member);
  }

  async scard(key: string): Promise<unknown> {
    const client = await getClient();
    const { count, error } = await client
      .from("durak_set_members")
      .select("member", { count: "exact", head: true })
      .eq("set_key", key);

    if (error) throw error;
    return count ?? 0;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    const client = await getClient();
    const { data, error } = await client
      .from("durak_kv")
      .select("key, value")
      .in("key", keys);

    if (error) throw error;
    const map = new Map(((data ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    return keys.map((k) => map.get(k) ?? null);
  }
}
