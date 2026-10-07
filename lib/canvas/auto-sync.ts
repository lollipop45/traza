import { runCanvasSync, type CanvasSyncResult, type SyncDeps } from "./sync";
import {
  CANVAS_SYNC_LEASE_SECONDS,
  isAuthErrorCode,
  nextEligibleSeconds,
  type SyncErrorCode,
  type SyncRecordResult,
  type SyncTrigger,
} from "./sync-policy";

// One Canvas sync run under the per-user database lease, for BOTH triggers:
//   automatic  the private app's background check (POST /api/integrations/canvas/auto-sync);
//              respects the cooldown;
//   manual     "Sincronizar Campus"; skips the cooldown, never an active lease.
// The assignment rules are not here: this only wraps the one engine (runCanvasSync) with
// claim → sync → record + release. Independent of Next.js and Supabase (tested with fakes);
// lib/canvas/sync-deps.ts wires the real store and Canvas.
//
// Opportunistic only: it always runs inside a request of the signed-in user. A future trusted
// scheduler would call the same engine with its own deps; nothing here acts for an offline user.

export type SyncOutcome = "success" | "not_due" | "already_running" | "no_linked_courses" | "temporary_error" | "auth_error";

export type SyncClaim = { claimed: boolean; reason: string; leaseToken: string | null; consecutiveFailures: number };

export type SyncRecord = {
  result: SyncRecordResult;
  errorCode: SyncErrorCode | null;
  nextEligibleSeconds: number;
  courses: number;
  imported: number;
  updated: number;
  unchanged: number;
  ignored: number;
  skipped: number;
  review: number;
};

export type SyncStateStore = {
  /** claim_canvas_sync. Null on a database error (nothing is run then). */
  claim: (trigger: SyncTrigger, leaseSeconds: number) => Promise<SyncClaim | null>;
  /** finish_canvas_sync: records and releases. False if the lease was lost or on error. */
  finish: (leaseToken: string, record: SyncRecord) => Promise<boolean>;
};

export type LeasedSyncDeps = {
  state: SyncStateStore;
  /** Built only once the lease is held (so a not-due request never touches Canvas). */
  createSync: () => SyncDeps;
  now: () => number;
};

export type LeasedSyncResult = {
  outcome: SyncOutcome;
  trigger: SyncTrigger;
  coursesChecked: number;
  assignmentsSeen: number;
  imported: number;
  updated: number;
  unchanged: number;
  ignored: number;
  reviewRequired: number;
  skipped: number;
  durationMs: number;
  errorCode: SyncErrorCode | null;
  /** The engine's full result (manual sync shows it); null when the engine did not run. */
  sync: CanvasSyncResult | null;
};

const ZERO = { coursesChecked: 0, assignmentsSeen: 0, imported: 0, updated: 0, unchanged: 0, ignored: 0, reviewRequired: 0, skipped: 0 };

/** Outcome of a finished engine run (pure, exported for tests). */
export function classifySyncResult(sync: CanvasSyncResult): { outcome: SyncOutcome; errorCode: SyncErrorCode | null } {
  if (!sync.ok) return { outcome: isAuthErrorCode(sync.code) ? "auth_error" : "temporary_error", errorCode: sync.code };
  if (sync.summary.coursesFailed > 0) {
    const code = sync.summary.errorCode ?? "unexpected";
    return { outcome: isAuthErrorCode(code) ? "auth_error" : "temporary_error", errorCode: code };
  }
  return { outcome: "success", errorCode: null };
}

export async function runLeasedCanvasSync(deps: LeasedSyncDeps, trigger: SyncTrigger): Promise<LeasedSyncResult> {
  const started = deps.now();
  const done = (outcome: SyncOutcome, rest: Partial<LeasedSyncResult> = {}): LeasedSyncResult => ({
    outcome,
    trigger,
    ...ZERO,
    errorCode: null,
    sync: null,
    ...rest,
    durationMs: Math.max(0, deps.now() - started),
  });

  let claim: SyncClaim | null;
  try {
    claim = await deps.state.claim(trigger, CANVAS_SYNC_LEASE_SECONDS);
  } catch {
    claim = null;
  }
  // Without the lease nothing touches Canvas or the tasks.
  if (!claim) return done("temporary_error", { errorCode: "database" });
  if (!claim.claimed || !claim.leaseToken) return done(claim.reason === "not_due" ? "not_due" : "already_running");

  let result: LeasedSyncResult;
  try {
    const sync = deps.createSync();
    const links = await sync.loadLinks();
    if (links.ok && !links.links.some((link) => link.state === "linked" && link.project_id)) {
      // Nothing to read: Canvas is not called at all.
      result = done("no_linked_courses");
    } else {
      const engine = await runCanvasSync(sync, "sync");
      const { outcome, errorCode } = classifySyncResult(engine);
      const summary = engine.ok ? engine.summary : null;
      result = done(outcome, {
        errorCode,
        sync: engine,
        ...(summary
          ? {
              coursesChecked: summary.coursesChecked,
              assignmentsSeen: summary.assignmentsReceived,
              imported: summary.created,
              updated: summary.updated,
              unchanged: summary.unchanged,
              ignored: summary.userIgnored,
              reviewRequired: summary.review,
              skipped: summary.omitted,
            }
          : {}),
      });
    }
  } catch {
    // Discarded: it could carry request details. The run is recorded as a temporary failure.
    result = done("temporary_error", { errorCode: "unexpected" });
  }

  const recorded: SyncRecordResult =
    result.outcome === "success" || result.outcome === "no_linked_courses" || result.outcome === "auth_error" ? result.outcome : "temporary_error";
  try {
    await deps.state.finish(claim.leaseToken, {
      result: recorded,
      errorCode: result.errorCode,
      nextEligibleSeconds: nextEligibleSeconds(recorded, claim.consecutiveFailures),
      courses: result.coursesChecked,
      imported: result.imported,
      updated: result.updated,
      unchanged: result.unchanged,
      ignored: result.ignored,
      skipped: result.skipped,
      review: result.reviewRequired,
    });
  } catch {
    // The lease then simply expires (CANVAS_SYNC_LEASE_SECONDS).
  }
  return result;
}

/** "TRAZA Canvas auto-sync: outcome=success trigger=automatic courses=3 …" — counts and enums only. */
export function syncLogLine(result: LeasedSyncResult): string {
  const parts = [
    `outcome=${result.outcome}`,
    `trigger=${result.trigger}`,
    `courses=${result.coursesChecked}`,
    `seen=${result.assignmentsSeen}`,
    `imported=${result.imported}`,
    `updated=${result.updated}`,
    `unchanged=${result.unchanged}`,
    `ignored=${result.ignored}`,
    `review=${result.reviewRequired}`,
    `duration=${result.durationMs}ms`,
  ];
  if (result.errorCode) parts.push(`code=${result.errorCode}`);
  return `TRAZA Canvas auto-sync: ${parts.join(" ")}`;
}
