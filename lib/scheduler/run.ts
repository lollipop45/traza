import type { LeasedSyncResult } from "@/lib/canvas/auto-sync";
import type { GoogleSyncOutcome } from "@/lib/google-calendar/auto-sync";
import type { NotificationRunResult } from "@/lib/notifications/run";
import { SCHEDULER_NEW_WORK_MS } from "./policy";

// One invocation of the trusted background scheduler: three independent lanes (reminders, Canvas,
// Google), started together and settled separately, so one failing never stops the others. Each
// lane asks its candidate query who could have something due, then runs the EXISTING engine for
// each such user, explicitly scoped to that user (deps.*.run). Independent of Next.js and Supabase
// (tested with fakes); lib/scheduler/deps.ts wires the real ones.
//
// Bounded: at most SCHEDULER_MAX_USERS per lane, no new user after SCHEDULER_NEW_WORK_MS, and every
// Canvas / Google request ends by the hard deadline handed to the engines. Running out of time
// never corrupts anything: work not started is simply picked up by a later invocation, and a run
// cut short keeps its database lease only until the lease expires.
//
// Only aggregate counts and enums leave this module: never a user id, title, endpoint or token.

export type CanvasCandidate =
  | { kind: "not_configured" }
  | { kind: "no_users" }
  | { kind: "multiple_users" }
  | { kind: "not_due" }
  | { kind: "unavailable" }
  | { kind: "due"; userId: string };

export type UserCandidates = { kind: "not_configured" } | { kind: "unavailable" } | { kind: "ok"; checked: number; due: string[] };

/** One user's run with the existing engine, explicitly scoped to that user (lib/scheduler/scoped-deps.ts). */
export type UserRun<T> = (userId: string) => Promise<T>;

export type SchedulerDeps = {
  now: () => number;
  notifications: { candidates: () => Promise<UserCandidates>; run: UserRun<NotificationRunResult> };
  canvas: { candidate: () => Promise<CanvasCandidate>; run: UserRun<LeasedSyncResult> };
  google: { candidates: () => Promise<UserCandidates>; run: UserRun<{ outcome: GoogleSyncOutcome }> };
};

export type LaneOutcome = "done" | "not_configured" | "unavailable" | "error";

export type CanvasOutcome =
  | Exclude<CanvasCandidate["kind"], "due">
  | LeasedSyncResult["outcome"]
  | "deferred"
  | "error";

export type SchedulerResult = {
  ok: true;
  outcome: "success" | "partial";
  notifications: { outcome: LaneOutcome; usersChecked: number; usersRun: number; deferred: number; deliveriesAttempted: number; sent: number };
  canvas: { outcome: CanvasOutcome };
  google: { outcome: LaneOutcome; usersChecked: number; successful: number; skipped: number; failed: number; deferred: number };
  durationMs: number;
};

const GOOGLE_SKIPPED = new Set<GoogleSyncOutcome>(["not_due", "already_running", "not_connected", "no_calendar"]);

export async function runScheduler(deps: SchedulerDeps): Promise<SchedulerResult> {
  const started = deps.now();
  const acceptsNewWork = () => deps.now() - started < SCHEDULER_NEW_WORK_MS;

  const notifications: SchedulerResult["notifications"] = { outcome: "done", usersChecked: 0, usersRun: 0, deferred: 0, deliveriesAttempted: 0, sent: 0 };
  const canvas: SchedulerResult["canvas"] = { outcome: "not_due" };
  const google: SchedulerResult["google"] = { outcome: "done", usersChecked: 0, successful: 0, skipped: 0, failed: 0, deferred: 0 };

  const notificationLane = async () => {
    const candidates = await deps.notifications.candidates();
    if (candidates.kind !== "ok") {
      notifications.outcome = candidates.kind;
      return;
    }
    notifications.usersChecked = candidates.checked;
    for (const [index, userId] of candidates.due.entries()) {
      if (!acceptsNewWork()) {
        notifications.deferred = candidates.due.length - index;
        break;
      }
      // One user's failure is that user's only.
      const result = await deps.notifications.run(userId).catch(() => null);
      if (!result) continue;
      notifications.usersRun++;
      notifications.deliveriesAttempted += result.sent + result.skipped + result.failed;
      notifications.sent += result.sent;
    }
  };

  const canvasLane = async () => {
    const candidate = await deps.canvas.candidate();
    if (candidate.kind !== "due") {
      canvas.outcome = candidate.kind;
      return;
    }
    if (!acceptsNewWork()) {
      canvas.outcome = "deferred";
      return;
    }
    const result = await deps.canvas.run(candidate.userId);
    canvas.outcome = result.outcome;
  };

  const googleLane = async () => {
    const candidates = await deps.google.candidates();
    if (candidates.kind !== "ok") {
      google.outcome = candidates.kind;
      return;
    }
    google.usersChecked = candidates.checked;
    google.skipped = candidates.checked - candidates.due.length;
    for (const [index, userId] of candidates.due.entries()) {
      if (!acceptsNewWork()) {
        google.deferred = candidates.due.length - index;
        break;
      }
      const result = await deps.google.run(userId).catch(() => null);
      if (result?.outcome === "success") google.successful++;
      else if (result && GOOGLE_SKIPPED.has(result.outcome)) google.skipped++;
      else google.failed++;
    }
  };

  const [n, c, g] = await Promise.allSettled([notificationLane(), canvasLane(), googleLane()]);
  // A lane that threw keeps the counts it reached; its outcome says it did not finish.
  if (n.status === "rejected") notifications.outcome = "error";
  if (c.status === "rejected") canvas.outcome = "error";
  if (g.status === "rejected") google.outcome = "error";

  const failed = notifications.outcome === "error" || canvas.outcome === "error" || google.outcome === "error";
  return {
    ok: true,
    outcome: failed ? "partial" : "success",
    notifications,
    canvas,
    google,
    durationMs: Math.max(0, deps.now() - started),
  };
}

/** "TRAZA scheduler: outcome=success notifications=1 canvas=not_due google=0 duration=812ms" — counts and enums only. */
export function schedulerLogLine(result: SchedulerResult): string {
  return [
    "TRAZA scheduler:",
    `outcome=${result.outcome}`,
    `notifications=${result.notifications.sent}`,
    `notifications_lane=${result.notifications.outcome}`,
    `canvas=${result.canvas.outcome}`,
    `google=${result.google.successful}`,
    `google_lane=${result.google.outcome}`,
    `duration=${result.durationMs}ms`,
  ].join(" ");
}
