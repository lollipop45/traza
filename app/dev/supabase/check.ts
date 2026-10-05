import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export type SupabaseCheck =
  /** Env vars absent: nothing was attempted. */
  | { state: "missing-config" }
  /** Supabase could not be reached or rejected the API key: a real configuration/network failure. */
  | { state: "unreachable"; status: number; code?: string }
  /** Connected, but `public.tasks` does not exist: the migration has not been applied. */
  | { state: "schema-missing"; code: string }
  /** No session, and the database denies anonymous access. The expected signed-out state. */
  | { state: "signed-out-blocked"; status: number; code: string }
  /** No session, yet the query ran. Anonymous access is open: a security problem. */
  | { state: "signed-out-readable"; visibleRows: number }
  /** Signed in, but privileges are missing (the grants migration is not applied). */
  | { state: "signed-in-blocked"; userId: string; status: number; code: string }
  /** Signed in and the query ran; every visible row must belong to this user. */
  | { state: "signed-in-readable"; userId: string; visibleRows: number; foreignRows: number };

/**
 * Smallest possible server-side probe: verify the session (getClaims), then read up to 50 tasks
 * through RLS. Only status/error codes are surfaced, never messages that could echo configuration.
 */
export async function checkSupabase(): Promise<SupabaseCheck> {
  if (!hasSupabaseEnv()) return { state: "missing-config" };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;

  const { data, error, status } = await supabase.from("tasks").select("id, user_id").limit(50);

  if (error) {
    // PostgREST: relation not found in the schema cache.
    if (error.code === "PGRST205" || error.code === "42P01") return { state: "schema-missing", code: error.code };
    // Postgres insufficient_privilege.
    if (error.code === "42501") {
      return userId
        ? { state: "signed-in-blocked", userId, status, code: error.code }
        : { state: "signed-out-blocked", status, code: error.code };
    }
    // Network failures (status 0), an invalid API key (401 without a Postgres code), JWT errors, etc.
    return { state: "unreachable", status, code: error.code || undefined };
  }

  if (!userId) return { state: "signed-out-readable", visibleRows: data.length };
  return {
    state: "signed-in-readable",
    userId,
    visibleRows: data.length,
    foreignRows: data.filter((row) => row.user_id !== userId).length,
  };
}
