import { parseNewProject, parseProjectId, type NewProjectDetails } from "@/lib/projects/validation";
import { formField } from "@/lib/validation";
import { courseSnapshot, isCanvasCourseId, resolveCourseForMapping, type CourseSnapshot } from "./mapping";
import type { CanvasOverview } from "./read";

// The rules behind every Canvas course decision, independent of Next.js and Supabase so they can
// be tested with a mocked Canvas and store. lib/canvas/actions.ts wires the real dependencies.
//
// Every write of a decision first re-reads the user's courses from Canvas on the server and only
// accepts a course id found there; the stored name/code come from that server response.

export type DecisionWrite = CourseSnapshot & { state: "linked" | "ignored"; project_id: string | null };

export type DecisionStore = {
  /** Insert or update the user's decision for this course. */
  saveDecision(write: DecisionWrite): Promise<boolean>;
  /** Atomically create the project and link the course to it. */
  createProjectWithLink(snapshot: CourseSnapshot, project: NewProjectDetails): Promise<boolean>;
  /** Remove the decision: the course becomes unmapped. Projects are never touched. */
  clearDecision(courseId: string): Promise<boolean>;
};

export type DecisionDeps = {
  loadOverview: () => Promise<CanvasOverview>;
  store: DecisionStore;
};

export type DecisionInput =
  | { action: "link"; courseId: unknown; formData: FormData }
  | { action: "ignore"; courseId: unknown }
  | { action: "create-project"; courseId: unknown; formData: FormData }
  | { action: "clear"; courseId: unknown };

export type DecisionResult = { ok: true } | { ok: false; error: string };

const SAVE_FAILED = "No se ha podido guardar.";

export async function applyCourseDecision(deps: DecisionDeps, input: DecisionInput): Promise<DecisionResult> {
  // Removing a decision needs no Canvas call: it only deletes the user's own row (RLS), so it also
  // works while Campus is unavailable.
  if (input.action === "clear") {
    if (!isCanvasCourseId(input.courseId)) return { ok: false, error: "El curso no es válido." };
    return (await deps.store.clearDecision(input.courseId)) ? { ok: true } : { ok: false, error: "No se ha podido actualizar." };
  }

  // Validate the browser's other fields before calling Canvas.
  let projectId: string | null = null;
  let project: NewProjectDetails | null = null;
  if (input.action === "link") {
    const parsed = parseProjectId(formField(input.formData, "project_id"));
    if (!parsed.ok) return parsed;
    if (!parsed.value) return { ok: false, error: "Elige un proyecto." };
    projectId = parsed.value;
  }
  if (input.action === "create-project") {
    const parsed = parseNewProject(input.formData);
    if (!parsed.ok) return parsed;
    project = parsed.value;
  }

  const resolution = resolveCourseForMapping(input.courseId, await deps.loadOverview());
  if (!resolution.ok) return resolution;
  const snapshot = courseSnapshot(resolution.course);

  if (input.action === "create-project" && project) {
    return (await deps.store.createProjectWithLink(snapshot, project)) ? { ok: true } : { ok: false, error: "No se ha podido crear el proyecto." };
  }
  const write: DecisionWrite =
    input.action === "link" ? { ...snapshot, state: "linked", project_id: projectId } : { ...snapshot, state: "ignored", project_id: null };
  return (await deps.store.saveDecision(write)) ? { ok: true } : { ok: false, error: SAVE_FAILED };
}
