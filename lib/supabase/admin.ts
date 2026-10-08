import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// THE privileged Supabase client (Supabase secret key, `sb_secret_…`). It bypasses Row Level
// Security, so it exists for ONE caller: the trusted background scheduler (lib/scheduler/), reached
// only through POST /api/internal/scheduler with the SCHEDULER_SECRET. Interactive requests never
// use it: they keep the user's session, the `authenticated` role and RLS (lib/supabase/server.ts).
// tests/unit/scheduler.test.ts fails if any other module imports this file.
//
// What the scheduler does with it (lib/scheduler/candidates.ts, lib/scheduler/user-session.ts):
//   - bounded, read-only candidate queries ("whose Canvas / Google / reminders are due?"), never
//     selecting token ciphertext, endpoints or keys;
//   - opening a short-lived session AS one of those users (Auth admin API), so the actual work runs
//     through the normal user-scoped client, RLS and the functions pinned to auth.uid().
//
//   SUPABASE_SECRET_KEY   server-only secret (Supabase → Project Settings → API Keys → Secret keys).
//                         Never NEXT_PUBLIC_, never logged, never rendered, never sent to a browser.

export type AdminClient = SupabaseClient<Database>;

/** Supabase secret API keys: "sb_secret_" + an opaque token. Legacy JWT-format keys are refused. */
export function isSupabaseSecretKey(value: string): boolean {
  return /^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(value);
}

/** The secret key, or null when absent or not a `sb_secret_` key. `env` is injectable for tests. */
export function readSupabaseSecretKey(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.SUPABASE_SECRET_KEY?.trim();
  return value && isSupabaseSecretKey(value) ? value : null;
}

/**
 * A fresh privileged client, or null when not configured. Never shared between requests, never
 * given a user's cookies or access token, and it never stores or refreshes a session of its own.
 */
export function createAdminClient(env: Record<string, string | undefined> = process.env): AdminClient | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = readSupabaseSecretKey(env);
  if (!url || !secretKey) return null;
  return createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
