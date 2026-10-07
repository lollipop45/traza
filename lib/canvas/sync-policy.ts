import type { CanvasErrorKind, CanvasFailureDetail } from "./types";

// THE place for the Canvas sync timing policy and its safe error vocabulary. Pure (no secrets, no
// server-only imports), so the database functions, the server runner and the browser trigger all
// read the same numbers. The database (claim_canvas_sync / finish_canvas_sync) is the authority
// that enforces the lease and the cooldown; it only bounds the values passed from here.

/** One sync per user at a time. A crashed request blocks sync for at most this long. */
export const CANVAS_SYNC_LEASE_SECONDS = 5 * 60;

/**
 * Every Canvas request of one run must finish before this (well inside the lease), so a lease is
 * never released by expiry while its holder is still writing.
 */
export const CANVAS_SYNC_DEADLINE_MS = 4 * 60 * 1000;

/** An automatic run is not started again sooner than this after a successful one. Manual runs ignore it. */
export const AUTO_SYNC_COOLDOWN_SECONDS = 30 * 60;

/** Temporary failures: 5, 10, 20, 40 min, then every 60 min (never a tight retry loop). */
export const FAILURE_BACKOFF_SECONDS = [5 * 60, 10 * 60, 20 * 60, 40 * 60, 60 * 60] as const;

/** Rejected token / wrong configuration: retrying soon cannot help; the user must act. */
export const AUTH_ERROR_BACKOFF_SECONDS = 2 * 60 * 60;

// Browser trigger (CanvasAutoSyncTrigger). The server-side cooldown stays authoritative: these only
// keep the number of cheap "is it due?" requests low.
/** First check after the private app loads (never blocks rendering). */
export const AUTO_SYNC_INITIAL_DELAY_MS = 3_000;
/** While TRAZA stays open. */
export const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** Coming back to a tab hidden at least this long triggers a check. */
export const AUTO_SYNC_HIDDEN_THRESHOLD_MS = 10 * 60 * 1000;
/** A tab never asks more often than this, whatever happens. */
export const AUTO_SYNC_MIN_GAP_MS = 5 * 60 * 1000;

export type SyncTrigger = "automatic" | "manual";

/** Stored in canvas_sync_state.last_result. */
export type SyncRecordResult = "success" | "no_linked_courses" | "temporary_error" | "auth_error";

/** Safe failure codes (canvas_sync_state.last_error_code). Never a message or a body. */
export type SyncErrorCode =
  | "network"
  | "timeout"
  | "canvas_401"
  | "canvas_403"
  | "canvas_429"
  | "canvas_5xx"
  | "canvas_redirect"
  | "not_configured"
  | "database"
  | "unexpected";

/** Codes a retry cannot fix: the token, permissions or configuration must change. */
const AUTH_CODES = new Set<SyncErrorCode>(["canvas_401", "canvas_403", "canvas_redirect", "not_configured"]);

export function isAuthErrorCode(code: SyncErrorCode): boolean {
  return AUTH_CODES.has(code);
}

/** A failed Canvas call, as carried by CanvasError / the read helpers. */
export type CanvasFailure = { kind: CanvasErrorKind; status: number | null; detail?: CanvasFailureDetail | null };

export function canvasFailureCode(failure: CanvasFailure | null | undefined): SyncErrorCode {
  if (!failure) return "unexpected";
  switch (failure.kind) {
    case "not-configured":
      return "not_configured";
    case "unauthorized":
      return "canvas_401";
    case "forbidden":
      return "canvas_403";
    case "redirected":
      return "canvas_redirect";
    case "unavailable":
      if (failure.status === 429) return "canvas_429";
      if (failure.status !== null && failure.status >= 500) return "canvas_5xx";
      return failure.detail === "timeout" ? "timeout" : "network";
    default:
      return "unexpected";
  }
}

/** Seconds until the next automatic run may start, after a run that ended with `result`. */
export function nextEligibleSeconds(result: SyncRecordResult, failuresBefore: number): number {
  if (result === "success" || result === "no_linked_courses") return AUTO_SYNC_COOLDOWN_SECONDS;
  if (result === "auth_error") return AUTH_ERROR_BACKOFF_SECONDS;
  const index = Math.min(Math.max(Math.trunc(failuresBefore) || 0, 0), FAILURE_BACKOFF_SECONDS.length - 1);
  return FAILURE_BACKOFF_SECONDS[index];
}
