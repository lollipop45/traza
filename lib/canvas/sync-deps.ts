import "server-only";
import { currentISODate } from "@/lib/calendar/dates";
import { getProjectOptions } from "@/lib/projects/queries";
import type { LeasedSyncDeps } from "./auto-sync";
import { getCanvasCourseLinks } from "./links";
import { getCanvasCourseAssignments, getCanvasOverview } from "./queries";
import type { SyncDeps } from "./sync";
import { CANVAS_SYNC_DEADLINE_MS } from "./sync-policy";
import { createSyncStateStore } from "./sync-state-store";
import { getCanvasAssignmentPreferences, getCanvasTaskExternalIds, upsertCanvasCourseTasks } from "./sync-store";

// The real dependencies of the one Canvas sync engine, shared by the manual Server Actions and the
// automatic endpoint, so both read Canvas and write tasks the same way. Server-only: callers must
// have verified the session; every store function re-checks it and RLS pins rows to the caller.

/** Engine deps. `deadline` bounds every Canvas request of the run (automatic and manual sync). */
export function createCanvasSyncDeps(options: { deadline?: number } = {}): SyncDeps {
  const read = { deadline: options.deadline };
  return {
    loadOverview: () => getCanvasOverview(read),
    loadLinks: getCanvasCourseLinks,
    loadProjectNames: async () => {
      const result = await getProjectOptions();
      return new Map(result.ok ? result.projects.map((project) => [project.id, project.name]) : []);
    },
    loadAssignments: (courseId) => getCanvasCourseAssignments(courseId, read),
    loadPreferences: getCanvasAssignmentPreferences,
    loadExistingExternalIds: getCanvasTaskExternalIds,
    upsertCourseTasks: upsertCanvasCourseTasks,
    today: currentISODate(),
  };
}

/** Lease + state + engine, for a run that writes (manual "Sincronizar" or automatic). */
export function createLeasedSyncDeps(): LeasedSyncDeps {
  return {
    state: createSyncStateStore(),
    // The deadline starts when the lease is held, well inside it.
    createSync: () => createCanvasSyncDeps({ deadline: Date.now() + CANVAS_SYNC_DEADLINE_MS }),
    now: Date.now,
  };
}
