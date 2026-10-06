import type { CanvasAssignment } from "./types";

// A Canvas assignment is NOT automatically a TRAZA task. The Assignments API also returns gradebook
// columns ("NOTAS FINALES AUDS"), attendance ("Roll Call Attendance") and other administrative
// entries. This pure layer decides, from Canvas metadata first and conservative title rules
// second, whether an assignment is actionable, obviously not, or needs the user's review.

export type ActionableReason = "student-submission" | "external-tool" | "on-paper-dated";
export type IgnoredReason = "gradebook" | "attendance";
export type ReviewReason = "no-student-action" | "on-paper-undated" | "conflicting-signals" | "unknown-type";

export type AssignmentClass =
  | { kind: "actionable"; reason: ActionableReason }
  | { kind: "ignored-by-rule"; reason: IgnoredReason }
  | { kind: "needs-review"; reason: ReviewReason };

/** The student hands something in through Canvas itself. */
export const STUDENT_SUBMISSION_TYPES = new Set([
  "online_upload",
  "online_text_entry",
  "online_url",
  "media_recording",
  "student_annotation",
  "online_quiz",
  "discussion_topic",
]);

/** Lowercase, no accents, no leading "[C.E]"-style tags, punctuation as spaces, single spaces. */
export function normalizeAssignmentTitle(title: string): string {
  return title
    .replace(/^\s*(?:[[(][^\])]*[\])]\s*)+/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Gradebook columns: the WHOLE title is a grade label ("Notas", "Calificaciones") or starts with
// a grade label + a qualifier ("Notas finales AUDS", "Nota final de prácticas", "Calificación
// global"). "Notas de campo" or "Entrega de notas" are deliberately NOT matched.
const GRADEBOOK = /^(notas?|calificacion(es)?)((\s+(final(es)?|parcial(es)?|medias?|global(es)?|definitivas?|ordinarias?|extraordinarias?))(\s.*)?)?$/;

// Attendance: the Canvas Roll Call tool's column, or a title that is only an attendance label.
const ROLL_CALL = /^roll call attendance$/;
const ATTENDANCE = /^(attendance|asistencia|asistencias|control de asistencia|asistencia a clases?|registro de asistencia)$/;

export function isGradebookTitle(title: string): boolean {
  return GRADEBOOK.test(normalizeAssignmentTitle(title));
}

export function isAttendanceTitle(title: string): boolean {
  const normalized = normalizeAssignmentTitle(title);
  return ROLL_CALL.test(normalized) || ATTENDANCE.test(normalized);
}

/**
 * The exact rules, first match wins:
 *   1. "Roll Call Attendance" (Canvas's attendance tool column) → ignored: attendance.
 *   2. Gradebook or attendance title, and NO student submission type → ignored-by-rule.
 *      The same title WITH a student submission type → needs-review (conflicting signals).
 *   3. A student submission type (upload, text, url, media, annotation, quiz, discussion)
 *      → actionable.
 *   4. external_tool → actionable (an external activity the student does).
 *   5. on_paper → actionable with a due date (an exam or in-person hand-in); review without one.
 *   6. Anything else — only "none" / "not_graded", an empty list, unknown types, or no
 *      submission_types at all → needs-review. Never imported silently.
 * Titles alone never make something actionable or exclude an exam: "Examen parcial", "Práctica 3"
 * or "Extra Parcial 1" are decided by their Canvas metadata. grading_type, points_possible and
 * omit_from_final_grade are read but deliberately not decisive: real exams can be ungraded or left
 * out of the final grade, and administrative columns can carry points.
 */
export function classifyAssignment(assignment: Pick<CanvasAssignment, "name" | "dueAt" | "submissionTypes">): AssignmentClass {
  const types = assignment.submissionTypes ?? [];
  const studentSubmission = types.some((type) => STUDENT_SUBMISSION_TYPES.has(type));
  const normalized = normalizeAssignmentTitle(assignment.name);

  if (ROLL_CALL.test(normalized)) return { kind: "ignored-by-rule", reason: "attendance" };

  const gradebook = GRADEBOOK.test(normalized);
  const attendance = ATTENDANCE.test(normalized);
  if (gradebook || attendance) {
    if (studentSubmission) return { kind: "needs-review", reason: "conflicting-signals" };
    return { kind: "ignored-by-rule", reason: gradebook ? "gradebook" : "attendance" };
  }

  if (studentSubmission) return { kind: "actionable", reason: "student-submission" };
  if (types.includes("external_tool")) return { kind: "actionable", reason: "external-tool" };
  if (types.includes("on_paper")) {
    return assignment.dueAt ? { kind: "actionable", reason: "on-paper-dated" } : { kind: "needs-review", reason: "on-paper-undated" };
  }
  if (assignment.submissionTypes === null) return { kind: "needs-review", reason: "unknown-type" };
  const known = new Set(["none", "not_graded"]);
  return types.every((type) => known.has(type))
    ? { kind: "needs-review", reason: "no-student-action" }
    : { kind: "needs-review", reason: "unknown-type" };
}

/** Restrained Spanish labels for the preview. */
export const CLASS_REASON_LABELS: Record<ActionableReason | IgnoredReason | ReviewReason, string> = {
  "student-submission": "Entrega en Campus",
  "external-tool": "Actividad externa",
  "on-paper-dated": "Entrega presencial",
  gradebook: "Elemento de calificación",
  attendance: "Asistencia",
  "no-student-action": "Sin acción de estudiante",
  "on-paper-undated": "Presencial sin fecha",
  "conflicting-signals": "Señales contradictorias",
  "unknown-type": "Tipo no reconocido",
};
