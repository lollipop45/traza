// THE place for the Google Calendar sync timing policy and its safe result vocabulary. Pure (no
// secrets, no server-only imports): the server runner and the browser trigger read the same numbers.
// The database (claim_google_calendar_sync / finish_google_calendar_sync) enforces the lease and the
// cooldown; it only bounds the values passed from here.

/** One Google sync per user at a time. A crashed request blocks sync for at most this long. */
export const GOOGLE_SYNC_LEASE_SECONDS = 5 * 60;

/** Every Google request of one run must finish before this (well inside the lease). */
export const GOOGLE_SYNC_DEADLINE_MS = 4 * 60 * 1000;

/** No automatic run sooner than this after a successful one. Manual runs ignore it. */
export const GOOGLE_AUTO_SYNC_COOLDOWN_SECONDS = 15 * 60;

/** Temporary failures (and rate limits): 5, 10, 20, 40 min, then every 60 min. */
export const GOOGLE_FAILURE_BACKOFF_SECONDS = [5 * 60, 10 * 60, 20 * 60, 40 * 60, 60 * 60] as const;

/**
 * Access lost or credentials unreadable: retrying cannot help until the user reconnects. The
 * database ignores this wait as soon as the connection is re-established (connected_at changes).
 */
export const GOOGLE_RECONNECT_BACKOFF_SECONDS = 6 * 60 * 60;

// Browser trigger (GoogleCalendarAutoSyncTrigger). The server-side cooldown stays authoritative.
export const GOOGLE_AUTO_SYNC_INITIAL_DELAY_MS = 5_000;
export const GOOGLE_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
export const GOOGLE_AUTO_SYNC_HIDDEN_THRESHOLD_MS = 10 * 60 * 1000;
/** No tab asks more often than this; tabs also share the last request time (localStorage). */
export const GOOGLE_AUTO_SYNC_MIN_GAP_MS = 4 * 60 * 1000;

export type GoogleSyncTrigger = "automatic" | "manual";

/** Stored in google_calendar_sync_state.last_result. */
export type GoogleSyncRecordResult =
  | "success"
  | "not_connected"
  | "no_calendar"
  | "reconnect_required"
  | "rate_limited"
  | "temporary_error"
  | "unexpected";

const SUCCESS = new Set<GoogleSyncRecordResult>(["success"]);

export function isSuccessResult(result: GoogleSyncRecordResult): boolean {
  return SUCCESS.has(result);
}

/** Seconds until the next automatic run may start, after a run that ended with `result`. */
export function googleNextEligibleSeconds(result: GoogleSyncRecordResult, failuresBefore: number): number {
  // Not connected / no calendar chosen yet: the user may fix it any minute (choosing a calendar
  // does not change connected_at), so only the normal cooldown applies.
  if (result === "success" || result === "not_connected" || result === "no_calendar") return GOOGLE_AUTO_SYNC_COOLDOWN_SECONDS;
  if (result === "reconnect_required") return GOOGLE_RECONNECT_BACKOFF_SECONDS;
  const index = Math.min(Math.max(Math.trunc(failuresBefore) || 0, 0), GOOGLE_FAILURE_BACKOFF_SECONDS.length - 1);
  return GOOGLE_FAILURE_BACKOFF_SECONDS[index];
}
