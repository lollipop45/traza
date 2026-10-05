import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export type SupabaseCheck =
  /** Env vars absent: nothing was attempted. */
  | { state: "missing-config" }
  /** Supabase could not be reached or rejected the API key: a real configuration/network failure. */
  | { state: "unreachable"; status: number; code?: string }
  /** Connected, but `public.tasks` does not exist: the migration has not been applied yet. */
  | { state: "schema-missing"; code: string }
  /** Connected and the table exists, but privileges/RLS deny access. Expected without a session. */
  | { state: "access-blocked"; status: number; code: string }
  /** Connected and the query ran; RLS still limits rows to the signed-in owner. */
  | { state: "readable"; visibleRows: number };

/**
 * Smallest possible server-side probe: one row from `tasks` with the publishable key and the
 * request's (currently absent) session. Only status/error codes are surfaced, never messages that
 * could echo configuration.
 */
export async function checkSupabase(): Promise<SupabaseCheck> {
  if (!hasSupabaseEnv()) return { state: "missing-config" };

  const supabase = await createClient();
  const { data, error, status } = await supabase.from("tasks").select("id").limit(1);

  if (!error) return { state: "readable", visibleRows: data.length };

  // PostgREST: relation not found in the schema cache.
  if (error.code === "PGRST205" || error.code === "42P01") {
    return { state: "schema-missing", code: error.code };
  }
  // Postgres insufficient_privilege (no GRANT for this role) or an RLS violation.
  if (error.code === "42501") {
    return { state: "access-blocked", status, code: error.code };
  }
  // Network failures (status 0), an invalid API key (401 without a Postgres code), JWT errors, etc.
  return { state: "unreachable", status, code: error.code || undefined };
}
