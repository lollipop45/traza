import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { GoogleSyncClaim, GoogleSyncRecord, GoogleSyncStateStore } from "./auto-sync";
import type { GoogleSyncTrigger } from "./sync-policy";
import { googleSyncStatusView, type GoogleSyncStateRow, type GoogleSyncStatusView } from "./sync-status";
import type { GoogleConnectionStatus } from "./types";

// Supabase access for public.google_calendar_sync_state. Server-only; callers must have verified the
// session. Both writes are the narrow SECURITY DEFINER functions claim_google_calendar_sync /
// finish_google_calendar_sync, which act only on auth.uid(): no user id is ever sent. Errors are not
// logged. No token is read or written here.

export function createGoogleSyncStateStore(): GoogleSyncStateStore {
  return {
    async claim(trigger: GoogleSyncTrigger, leaseSeconds: number): Promise<GoogleSyncClaim | null> {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("claim_google_calendar_sync", { p_trigger: trigger, p_lease_seconds: leaseSeconds });
      const row = Array.isArray(data) ? data[0] : null;
      if (error || !row || typeof row.claimed !== "boolean") return null;
      return {
        claimed: row.claimed,
        reason: String(row.reason),
        leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
        consecutiveFailures: typeof row.consecutive_failures === "number" ? row.consecutive_failures : 0,
      };
    },

    async finish(leaseToken: string, record: GoogleSyncRecord): Promise<boolean> {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("finish_google_calendar_sync", {
        p_lease_token: leaseToken,
        p_result: record.result,
        p_next_eligible_seconds: record.nextEligibleSeconds,
        p_created: record.created,
        p_updated: record.updated,
        p_imported: record.imported,
        p_deleted: record.deleted,
        p_unchanged: record.unchanged,
        p_failed: record.failed,
      });
      return !error && data === true;
    },
  };
}

async function getGoogleSyncState(userId: string): Promise<GoogleSyncStateRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("google_calendar_sync_state")
    .select("lease_until, last_success_at, last_result")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/** The sync status shown in the Calendar's Google section, as of now. */
export async function getGoogleSyncStatus(userId: string, connection: GoogleConnectionStatus): Promise<GoogleSyncStatusView> {
  const row = connection.state === "connected" ? await getGoogleSyncState(userId) : null;
  return googleSyncStatusView(connection, row, Date.now());
}
