import "server-only";
import { currentISODate } from "@/lib/calendar/dates";
import type { CanvasTaskWrite } from "@/lib/canvas/assignments";
import type { LeasedSyncDeps, SyncClaim, SyncRecord, SyncStateStore } from "@/lib/canvas/auto-sync";
import { CANVAS_COURSE_LINK_COLUMNS, type CanvasCourseLink } from "@/lib/canvas/mapping";
import { getCanvasCourseAssignments, getCanvasOverview } from "@/lib/canvas/queries";
import type { AssignmentPreference, SyncDeps, UpsertOutcome } from "@/lib/canvas/sync";
import { CANVAS_SYNC_DEADLINE_MS, type SyncTrigger } from "@/lib/canvas/sync-policy";
import type { ScheduledScope } from "../scope";

// Scheduled counterpart of lib/canvas/{sync-deps,sync-store,sync-state-store,links}.ts for ONE target
// user, through a ScheduledScope. Canvas itself is read with the same server-only reader
// (CANVAS_ACCESS_TOKEN; no session involved); TRAZA rows are read and written only for the scope's
// user; the lease, cooldown and task upsert go through the scheduler_* variants of the same database
// functions. The sync rules are the existing engine's (runCanvasSync / runLeasedCanvasSync).
//
// The scheduler only builds this for the single user allowed by the one-token rule (candidates.ts).

function createScheduledCanvasStateStore(scope: ScheduledScope): SyncStateStore {
  return {
    async claim(trigger: SyncTrigger, leaseSeconds: number): Promise<SyncClaim | null> {
      const { data, error } = await scope.rpc("scheduler_claim_canvas_sync", { p_trigger: trigger, p_lease_seconds: leaseSeconds });
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
      const { data, error } = await scope.rpc("scheduler_finish_canvas_sync", {
        p_lease_token: leaseToken,
        p_result: record.result,
        p_next_eligible_seconds: record.nextEligibleSeconds,
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

function createScheduledCanvasSyncDeps(scope: ScheduledScope, deadline: number): SyncDeps {
  const read = { deadline };
  return {
    loadOverview: () => getCanvasOverview(read),
    async loadLinks() {
      const { data, error } = await scope.select<CanvasCourseLink>("canvas_course_links", CANVAS_COURSE_LINK_COLUMNS).order("canvas_course_id", { ascending: true });
      return error ? { ok: false } : { ok: true, links: data };
    },
    async loadProjectNames() {
      const { data, error } = await scope.select<{ id: string; name: string }>("projects", "id, name");
      return new Map(error ? [] : data.map((project) => [project.id, project.name]));
    },
    loadAssignments: (courseId) => getCanvasCourseAssignments(courseId, read),
    async loadPreferences() {
      const { data, error } = await scope
        .select<AssignmentPreference>("canvas_assignment_preferences", "id, canvas_course_id, canvas_assignment_id, state, canvas_assignment_name")
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true });
      return error ? null : data;
    },
    async loadExistingExternalIds() {
      const { data, error } = await scope.select<{ external_id: string | null }>("tasks", "external_id").eq("source", "canvas").not("external_id", "is", null);
      if (error) return null;
      return new Set(data.map((row) => row.external_id).filter((id): id is string => id !== null));
    },
    async upsertCourseTasks(courseId: string, writes: CanvasTaskWrite[]): Promise<UpsertOutcome[] | null> {
      const { data, error } = await scope.rpc("scheduler_sync_canvas_course_tasks", { p_canvas_course_id: courseId, p_assignments: writes });
      return error || !Array.isArray(data) ? null : (data as UpsertOutcome[]);
    },
    today: currentISODate(),
  };
}

/**
 * Lease + state + engine deps for runLeasedCanvasSync, for the scope's user. `deadline` (absolute
 * ms) can only bring the run's own deadline earlier.
 */
export function createScheduledCanvasDeps(scope: ScheduledScope, options: { deadline: number }): LeasedSyncDeps {
  return {
    state: createScheduledCanvasStateStore(scope),
    createSync: () => createScheduledCanvasSyncDeps(scope, Math.min(Date.now() + CANVAS_SYNC_DEADLINE_MS, options.deadline)),
    now: Date.now,
  };
}
