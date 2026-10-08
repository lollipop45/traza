import type { ConnectionMetadata } from "./connection";
import { runGoogleSync, type GoogleSyncDeps, type GoogleSyncResult } from "./sync";
import {
  GOOGLE_SYNC_LEASE_SECONDS,
  googleNextEligibleSeconds,
  isSuccessResult,
  type GoogleSyncRecordResult,
  type GoogleSyncTrigger,
} from "./sync-policy";

// One Google Calendar sync run under the per-user database lease, for BOTH triggers:
//   automatic  the private app's background check (POST /api/integrations/google/auto-sync);
//              respects the cooldown;
//   manual     "Sincronizar Google Calendar"; skips the cooldown, never an active lease.
// The reconciliation rules are not here: this only wraps the one engine (runGoogleSync) with
// pre-checks → claim → sync → record + release. Independent of Next.js and Supabase (tested with
// fakes); lib/google-calendar/sync-deps.ts wires the real store and Google.
//
// It always runs as one user, through that user's session: the signed-in user's request, or the
// trusted scheduler (lib/scheduler/), which opens a session for each due user and calls this with
// the "automatic" trigger, so the same cooldown and lease apply.

export type GoogleSyncOutcome =
  | "success"
  | "not_due"
  | "already_running"
  | "not_connected"
  | "no_calendar"
  | "reconnect_required"
  | "credentials_missing"
  | "rate_limited"
  | "temporary_error";

export type GoogleSyncClaim = { claimed: boolean; reason: string; leaseToken: string | null; consecutiveFailures: number };

export type GoogleSyncRecord = {
  result: GoogleSyncRecordResult;
  nextEligibleSeconds: number;
  created: number;
  updated: number;
  imported: number;
  deleted: number;
  unchanged: number;
  failed: number;
};

export type GoogleSyncStateStore = {
  /** claim_google_calendar_sync. Null on a database error (nothing is run then). */
  claim: (trigger: GoogleSyncTrigger, leaseSeconds: number) => Promise<GoogleSyncClaim | null>;
  /** finish_google_calendar_sync: records and releases. False if the lease was lost or on error. */
  finish: (leaseToken: string, record: GoogleSyncRecord) => Promise<boolean>;
};

export type LeasedGoogleSyncDeps = {
  /** GOOGLE_* server configuration is complete and valid. */
  configured: boolean;
  /** Connection metadata (no tokens, no Google call). */
  loadMetadata: () => Promise<{ ok: true; metadata: ConnectionMetadata | null } | { ok: false }>;
  state: GoogleSyncStateStore;
  /** Built only once the lease is held (so a not-due request never touches Google or tokens). */
  createSync: () => GoogleSyncDeps;
  now: () => number;
};

export type LeasedGoogleSyncResult = {
  outcome: GoogleSyncOutcome;
  trigger: GoogleSyncTrigger;
  created: number;
  updated: number;
  imported: number;
  deleted: number;
  unchanged: number;
  failed: number;
  durationMs: number;
  /** The engine's full result (manual sync shows it); null when the engine did not run. */
  sync: GoogleSyncResult | null;
};

const ZERO = { created: 0, updated: 0, imported: 0, deleted: 0, unchanged: 0, failed: 0 };

/** Outcome and stored result of a finished engine run (pure, exported for tests). */
export function classifyGoogleSync(sync: GoogleSyncResult): { outcome: GoogleSyncOutcome; record: GoogleSyncRecordResult } {
  if (!sync.ok) {
    if (sync.code === "unexpected") return { outcome: "temporary_error", record: "unexpected" };
    return { outcome: sync.code, record: sync.code };
  }
  const { stopReason, failed } = sync.summary;
  if (stopReason) return { outcome: stopReason, record: stopReason };
  if (failed > 0) return { outcome: "temporary_error", record: "temporary_error" };
  return { outcome: "success", record: "success" };
}

export async function runLeasedGoogleSync(deps: LeasedGoogleSyncDeps, trigger: GoogleSyncTrigger): Promise<LeasedGoogleSyncResult> {
  const started = deps.now();
  const done = (outcome: GoogleSyncOutcome, rest: Partial<LeasedGoogleSyncResult> = {}): LeasedGoogleSyncResult => ({
    outcome,
    trigger,
    ...ZERO,
    sync: null,
    ...rest,
    durationMs: Math.max(0, deps.now() - started),
  });

  // Cheap pre-checks: no lease, no Google call, no token is read, nothing is written. A missing
  // configuration never touches the stored (encrypted) connection.
  if (!deps.configured) return done("credentials_missing");
  let metadata: Awaited<ReturnType<LeasedGoogleSyncDeps["loadMetadata"]>>;
  try {
    metadata = await deps.loadMetadata();
  } catch {
    metadata = { ok: false };
  }
  if (!metadata.ok) return done("temporary_error");
  if (!metadata.metadata) return done("not_connected");
  if (metadata.metadata.status !== "connected") return done("reconnect_required");
  if (!metadata.metadata.selectedCalendarId) return done("no_calendar");

  let claim: GoogleSyncClaim | null;
  try {
    claim = await deps.state.claim(trigger, GOOGLE_SYNC_LEASE_SECONDS);
  } catch {
    claim = null;
  }
  if (!claim) return done("temporary_error");
  if (!claim.claimed || !claim.leaseToken) return done(claim.reason === "not_due" ? "not_due" : "already_running");

  let result: LeasedGoogleSyncResult;
  let record: GoogleSyncRecordResult;
  try {
    const sync = await runGoogleSync(deps.createSync(), "sync");
    const classified = classifyGoogleSync(sync);
    record = classified.record;
    const summary = sync.ok ? sync.summary : null;
    result = done(classified.outcome, {
      sync,
      ...(summary
        ? {
            created: summary.events.create + summary.tasks.create,
            updated: summary.events.update + summary.tasks.update,
            imported: summary.imports.create + summary.imports.update,
            deleted: summary.removals,
            unchanged: summary.events.unchanged + summary.tasks.unchanged + summary.imports.unchanged,
            failed: summary.failed,
          }
        : {}),
    });
  } catch {
    // Discarded: it could carry request details. Recorded as an unexpected failure.
    record = "unexpected";
    result = done("temporary_error");
  }

  try {
    await deps.state.finish(claim.leaseToken, {
      result: record,
      nextEligibleSeconds: googleNextEligibleSeconds(record, isSuccessResult(record) ? 0 : claim.consecutiveFailures),
      created: result.created,
      updated: result.updated,
      imported: result.imported,
      deleted: result.deleted,
      unchanged: result.unchanged,
      failed: result.failed,
    });
  } catch {
    // The lease then simply expires (GOOGLE_SYNC_LEASE_SECONDS).
  }
  return result;
}

/** "TRAZA Google auto-sync: outcome=success trigger=automatic created=1 …" — enums and counts only. */
export function googleSyncLogLine(result: LeasedGoogleSyncResult): string {
  const parts = [
    `outcome=${result.outcome}`,
    `trigger=${result.trigger}`,
    `created=${result.created}`,
    `updated=${result.updated}`,
    `imported=${result.imported}`,
    `deleted=${result.deleted}`,
    `unchanged=${result.unchanged}`,
    `failed=${result.failed}`,
    `duration=${result.durationMs}ms`,
  ];
  return `TRAZA Google auto-sync: ${parts.join(" ")}`;
}
