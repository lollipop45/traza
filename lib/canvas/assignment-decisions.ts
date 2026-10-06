import { isUuid } from "@/lib/validation";
import { assignmentTitle } from "./assignments";
import { isCanvasCourseId, type CanvasCourseLink } from "./mapping";
import type { CanvasOverview } from "./read";
import { canvasUnavailableMessage, type AssignmentsRead } from "./sync";

// The rules behind every per-assignment decision ("Importar", "Ignorar", "Ignorar en TRAZA",
// "Restaurar"), independent of Next.js and Supabase so they can be tested with a mocked Canvas and
// store. lib/canvas/assignment-actions.ts wires the real dependencies.
//
// From the preview, the browser names an assignment by its Canvas ids; the server re-reads that
// course's assignments from Canvas and only accepts an assignment found there, in a course the user
// linked and Canvas still lists. The stored name comes from that response, never from the browser.
// From a task, the identity comes from the user's own task row (its external_id), so ignoring an
// imported false positive also works while Campus is unavailable.

export type AssignmentPreferenceStore = {
  /** set_canvas_assignment_preference: returns the number of tasks removed, or null on error. */
  setPreference(courseId: string, assignmentId: string, state: "included" | "ignored", name: string | null): Promise<number | null>;
  /** Removes one of the user's decisions (RLS). */
  deletePreference(preferenceId: string): Promise<boolean>;
};

export type CanvasTaskIdentity = { source: string; externalId: string | null; title: string };

export type AssignmentDecisionDeps = {
  loadOverview: () => Promise<CanvasOverview>;
  loadLinks: () => Promise<{ ok: true; links: CanvasCourseLink[] } | { ok: false }>;
  loadAssignments: (courseId: string) => Promise<AssignmentsRead>;
  /** The caller's own task (RLS), or null when missing / not theirs. */
  loadTask: (taskId: string) => Promise<CanvasTaskIdentity | null>;
  store: AssignmentPreferenceStore;
};

export type AssignmentDecisionInput =
  | { action: "include" | "ignore"; courseId: unknown; assignmentId: unknown }
  | { action: "ignore-task"; taskId: unknown }
  | { action: "restore"; preferenceId: unknown };

export type AssignmentDecisionResult = { ok: true; removedTask: boolean } | { ok: false; error: string };

const SAVE_FAILED = "No se ha podido guardar.";

export function isCanvasAssignmentId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

/** "course:<courseId>:assignment:<assignmentId>" → the two ids, or null for anything else. */
export function parseCanvasExternalId(externalId: string | null): { courseId: string; assignmentId: string } | null {
  const match = externalId?.match(/^course:([0-9]{1,20}):assignment:([0-9]{1,20})$/);
  return match ? { courseId: match[1], assignmentId: match[2] } : null;
}

export async function applyAssignmentDecision(deps: AssignmentDecisionDeps, input: AssignmentDecisionInput): Promise<AssignmentDecisionResult> {
  if (input.action === "restore") {
    if (!isUuid(input.preferenceId)) return { ok: false, error: "La entrega no es válida." };
    return (await deps.store.deletePreference(input.preferenceId)) ? { ok: true, removedTask: false } : { ok: false, error: "No se ha podido restaurar." };
  }

  if (input.action === "ignore-task") {
    if (!isUuid(input.taskId)) return { ok: false, error: "La tarea no es válida." };
    const task = await deps.loadTask(input.taskId);
    // Only Campus tasks: this path can never delete a manual task.
    if (!task || task.source !== "canvas") return { ok: false, error: "Solo se pueden ignorar tareas de Campus." };
    const identity = parseCanvasExternalId(task.externalId);
    if (!identity) return { ok: false, error: "Solo se pueden ignorar tareas de Campus." };
    const removed = await deps.store.setPreference(identity.courseId, identity.assignmentId, "ignored", assignmentTitle(task.title) || null);
    return removed === null ? { ok: false, error: SAVE_FAILED } : { ok: true, removedTask: removed > 0 };
  }

  // include / ignore from the preview: verify against live Canvas before writing.
  if (!isCanvasCourseId(input.courseId) || !isCanvasAssignmentId(input.assignmentId)) return { ok: false, error: "La entrega no es válida." };
  const overview = await deps.loadOverview();
  if (overview.state !== "connected") return { ok: false, error: canvasUnavailableMessage(overview) };
  if (!overview.courses.some((course) => course.id === input.courseId)) {
    return { ok: false, error: "Este curso no está entre tus cursos activos de Campus Virtual." };
  }
  const links = await deps.loadLinks();
  if (!links.ok) return { ok: false, error: "No se han podido cargar tus vínculos con Campus." };
  if (!links.links.some((link) => link.canvas_course_id === input.courseId && link.state === "linked")) {
    return { ok: false, error: "Este curso no está vinculado a un proyecto." };
  }
  const read = await deps.loadAssignments(input.courseId);
  if (!read.ok) return { ok: false, error: "Campus Virtual no está disponible en este momento." };
  const assignment = read.assignments.find((candidate) => candidate.id === input.assignmentId);
  if (!assignment) return { ok: false, error: "Esta entrega no está en Campus Virtual." };

  const state = input.action === "include" ? "included" : "ignored";
  const removed = await deps.store.setPreference(input.courseId, input.assignmentId, state, assignmentTitle(assignment.name) || null);
  return removed === null ? { ok: false, error: SAVE_FAILED } : { ok: true, removedTask: removed > 0 };
}
