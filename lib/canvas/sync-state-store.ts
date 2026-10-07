import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { SyncClaim, SyncRecord, SyncStateStore } from "./auto-sync";
import type { SyncTrigger } from "./sync-policy";
import { syncStatusView, type SyncStateRow, type SyncStatusView } from "./sync-status";

// Supabase access for public.canvas_sync_state. Server-only; callers must have verified the
// session. Both writes are the narrow SECURITY DEFINER functions claim_canvas_sync /
// finish_canvas_sync, which act only on auth.uid(): no user id is ever sent. Errors are not logged.

export function createSyncStateStore(): SyncStateStore {
  return {
    async claim(trigger: SyncTrigger, leaseSeconds: number): Promise<SyncClaim | null> {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("claim_canvas_sync", { p_trigger: trigger, p_lease_seconds: leaseSeconds });
      const row = Array.isArray(data) ? data[0] : null;
      if (error || !row || typeof row.claimed !== "boolean") return null;
      return {
        claimed: row.claimed,
        reason: String(row.reason),
        leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
        consecutiveFailures: typeof row.consecutive_failures === "number" ? row.consecutive_failures : 0,
      };
    },

    async finish(leaseToken: string, record: SyncRecord): Promise<boolean> {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("finish_canvas_sync", {
        p_lease_token: leaseToken,
        p_result: record.result,
        p_next_eligible_seconds: record.nextEligibleSeconds,
        // Optional argument (SQL default null): omitted rather than sent as null.
        p_error_code: record.errorCode ?? undefined,
        p_courses: record.courses,
        p_imported: record.imported,
        p_updated: record.updated,
        p_unchanged: record.unchanged,
        p_ignored: record.ignored,
        p_skipped: record.skipped,
        p_review: record.review,
      });
      return !error && data === true;
    },
  };
}

/** The caller's sync state for the Campus page (RLS: own row only). Null when none or on error. */
export async function getCanvasSyncState(userId: string): Promise<SyncStateRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("canvas_sync_state")
    .select("lease_until, last_success_at, last_attempt_at, last_result, last_review_count")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/** The status shown on the Campus page, as of now. */
export async function getCanvasSyncStatus(userId: string): Promise<SyncStatusView> {
  return syncStatusView(await getCanvasSyncState(userId), Date.now());
}
