"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { currentISODate } from "@/lib/calendar/dates";
import { getProjectOptions } from "@/lib/projects/queries";
import { revalidateTaskViews } from "@/lib/tasks/mutations";
import { getCanvasCourseLinks } from "./links";
import { getCanvasCourseAssignments, getCanvasOverview } from "./queries";
import { runCanvasSync, type CanvasSyncResult, type SyncDeps, type SyncMode } from "./sync";
import { getCanvasAssignmentPreferences, getCanvasTaskExternalIds, upsertCanvasCourseTasks } from "./sync-store";

// Manual Canvas assignment sync. Both actions verify the TRAZA session; runCanvasSync then reads
// the user's live Canvas courses on the server and only syncs linked courses found there. The
// browser sends nothing but the request itself. The result carries counts, titles and course/project
// names, plus the Canvas ids of listed assignments (only so "Importar" / "Ignorar" can name them back;
// never displayed): never tokens, URLs or raw Canvas responses.

async function deps(): Promise<SyncDeps> {
  return {
    loadOverview: getCanvasOverview,
    loadLinks: getCanvasCourseLinks,
    loadProjectNames: async () => {
      const result = await getProjectOptions();
      return new Map(result.ok ? result.projects.map((project) => [project.id, project.name]) : []);
    },
    loadAssignments: getCanvasCourseAssignments,
    loadPreferences: getCanvasAssignmentPreferences,
    loadExistingExternalIds: getCanvasTaskExternalIds,
    upsertCourseTasks: upsertCanvasCourseTasks,
    today: currentISODate(),
  };
}

async function run(mode: SyncMode): Promise<CanvasSyncResult> {
  await requireUser();
  const result = await runCanvasSync(await deps(), mode);
  if (mode === "sync" && result.ok) {
    revalidateTaskViews();
    revalidatePath("/projects/canvas");
  }
  return result;
}

/** Vista previa: reads Canvas and existing task ids; writes nothing. */
export async function previewCanvasSync(): Promise<CanvasSyncResult> {
  return run("preview");
}

/** Sincronizar Campus: imports/updates tasks for verified linked courses. */
export async function syncCanvasAssignments(): Promise<CanvasSyncResult> {
  return run("sync");
}
