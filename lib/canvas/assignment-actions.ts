"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { revalidateTaskViews } from "@/lib/tasks/mutations";
import { applyAssignmentDecision, type AssignmentDecisionDeps, type AssignmentDecisionInput, type AssignmentDecisionResult } from "./assignment-decisions";
import { getCanvasCourseLinks } from "./links";
import { getCanvasCourseAssignments, getCanvasOverview } from "./queries";
import {
  deleteCanvasAssignmentPreference,
  getCanvasTaskIdentity,
  setCanvasAssignmentPreference,
} from "./sync-store";

// Per-assignment decisions. Each action verifies the TRAZA session; applyAssignmentDecision then
// re-verifies the assignment against live Canvas (preview actions) or the user's own task row
// ("Ignorar en TRAZA"). The browser sends ids only; names come from the server.

const deps: AssignmentDecisionDeps = {
  loadOverview: getCanvasOverview,
  loadLinks: getCanvasCourseLinks,
  loadAssignments: getCanvasCourseAssignments,
  loadTask: getCanvasTaskIdentity,
  store: { setPreference: setCanvasAssignmentPreference, deletePreference: deleteCanvasAssignmentPreference },
};

async function decide(input: AssignmentDecisionInput): Promise<AssignmentDecisionResult> {
  await requireUser();
  const result = await applyAssignmentDecision(deps, input);
  if (result.ok) {
    revalidatePath("/projects/canvas");
    if (result.removedTask) revalidateTaskViews();
  }
  return result;
}

/** "Importar": import this review item from the next sync on. */
export async function includeCanvasAssignment(courseId: string, assignmentId: string): Promise<AssignmentDecisionResult> {
  return decide({ action: "include", courseId, assignmentId });
}

/** "Ignorar" (preview): never import it; removes its Campus task if one exists. */
export async function ignoreCanvasAssignment(courseId: string, assignmentId: string): Promise<AssignmentDecisionResult> {
  return decide({ action: "ignore", courseId, assignmentId });
}

/** "Ignorar en TRAZA" (task editor): ignore the task's assignment and remove the task. */
export async function ignoreCanvasTask(taskId: string): Promise<AssignmentDecisionResult> {
  return decide({ action: "ignore-task", taskId });
}

/** "Restaurar" / "Quitar": back to automatic classification. Creates no task by itself. */
export async function restoreCanvasAssignment(preferenceId: string): Promise<AssignmentDecisionResult> {
  return decide({ action: "restore", preferenceId });
}
