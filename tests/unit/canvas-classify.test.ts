// Canvas assignment classification (actionable / ignored-by-rule / needs-review) and the rules
// behind per-assignment decisions. Fake fixtures only; no network, no database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAssignmentDecision,
  parseCanvasExternalId,
  type AssignmentDecisionDeps,
  type CanvasTaskIdentity,
} from "@/lib/canvas/assignment-decisions";
import { parseAssignment, parseSubmissionTypes } from "@/lib/canvas/assignments";
import { classifyAssignment, isAttendanceTitle, isGradebookTitle, normalizeAssignmentTitle } from "@/lib/canvas/classify";
import type { CanvasCourseLink } from "@/lib/canvas/mapping";
import type { CanvasOverview } from "@/lib/canvas/read";
import type { AssignmentsRead } from "@/lib/canvas/sync";
import type { CanvasAssignment, CanvasCourse } from "@/lib/canvas/types";

const DUE = "2026-10-12T22:59:00Z";
const classify = (name: string, submissionTypes: string[] | null, dueAt: string | null = DUE) => classifyAssignment({ name, submissionTypes, dueAt });

describe("submission_types parsing", () => {
  it("lowercases, trims, deduplicates and drops non-strings", () => {
    assert.deepEqual(parseSubmissionTypes([" Online_Upload", "online_upload", 3, null, "", "on_paper"]), ["online_upload", "on_paper"]);
    assert.deepEqual(parseSubmissionTypes([]), []);
  });

  it("treats a missing or non-array value as unknown (null)", () => {
    for (const value of [undefined, null, "online_upload", { 0: "none" }]) assert.equal(parseSubmissionTypes(value), null);
  });

  it("reads the new grading fields defensively", () => {
    const parsed = parseAssignment(
      { id: "1", name: "Notas", submission_types: ["none"], grading_type: "Not_Graded", points_possible: "10", omit_from_final_grade: "yes" },
      "145580",
    );
    assert.deepEqual(
      parsed && [parsed.submissionTypes, parsed.gradingType, parsed.pointsPossible, parsed.omitFromFinalGrade],
      [["none"], "not_graded", null, null],
    );
    const valid = parseAssignment({ id: "1", name: "x", points_possible: 7.5, omit_from_final_grade: true }, "145580");
    assert.deepEqual(valid && [valid.pointsPossible, valid.omitFromFinalGrade], [7.5, true]);
  });
});

describe("title normalisation", () => {
  it("removes accents, case, punctuation and leading bracket tags", () => {
    assert.equal(normalizeAssignmentTitle("  [C.E] Notas  Finales "), "notas finales");
    assert.equal(normalizeAssignmentTitle("CALIFICACIÓN FINAL"), "calificacion final");
    assert.equal(normalizeAssignmentTitle("(G1) [2025] Asistencia."), "asistencia");
    assert.equal(normalizeAssignmentTitle("PRÁCTICA NÚMERO 3: SECCIÓN"), "practica numero 3 seccion");
  });

  it("recognises gradebook and attendance labels conservatively", () => {
    for (const title of ["NOTAS FINALES AUDS", "[C.E] Notas Finales", "Notas", "Nota final de prácticas", "Calificaciones", "CALIFICACIÓN GLOBAL"]) {
      assert.ok(isGradebookTitle(title), title);
    }
    for (const title of ["Notas de campo", "Entrega de notas", "Cuaderno de notas", "Notación gráfica", "Examen parcial", "Práctica 3"]) {
      assert.ok(!isGradebookTitle(title), title);
    }
    for (const title of ["Roll Call Attendance", "Asistencia", "ASISTENCIA", "Control de asistencia", "Attendance"]) assert.ok(isAttendanceTitle(title), title);
    for (const title of ["Asistencia a la exposición: entrega de memoria", "Informe de asistencia técnica"]) assert.ok(!isAttendanceTitle(title), title);
  });
});

describe("classifyAssignment", () => {
  it("ignores the real Campus gradebook and attendance entries", () => {
    assert.deepEqual(classify("NOTAS FINALES AUDS", ["none"], null), { kind: "ignored-by-rule", reason: "gradebook" });
    assert.deepEqual(classify("[C.E] Notas Finales", ["none"], null), { kind: "ignored-by-rule", reason: "gradebook" });
    assert.deepEqual(classify("[C.E] Notas Finales", ["on_paper"]), { kind: "ignored-by-rule", reason: "gradebook" });
    assert.deepEqual(classify("Roll Call Attendance", ["external_tool"]), { kind: "ignored-by-rule", reason: "attendance" });
    assert.deepEqual(classify("Roll Call Attendance", ["online_upload"]), { kind: "ignored-by-rule", reason: "attendance" });
    assert.deepEqual(classify("Asistencia", ["none"], null), { kind: "ignored-by-rule", reason: "attendance" });
    assert.deepEqual(classify("Asistencia", ["external_tool"]), { kind: "ignored-by-rule", reason: "attendance" });
  });

  it("sends an admin-looking title with a real student submission to review, not to the bin", () => {
    assert.deepEqual(classify("Asistencia", ["online_upload"]), { kind: "needs-review", reason: "conflicting-signals" });
    assert.deepEqual(classify("Notas finales", ["online_text_entry"]), { kind: "needs-review", reason: "conflicting-signals" });
  });

  it("keeps every student submission type actionable", () => {
    for (const type of ["online_upload", "online_text_entry", "online_url", "media_recording", "student_annotation", "online_quiz", "discussion_topic"]) {
      assert.deepEqual(classify("ENTREGA ACTIVIDAD 1: MY DREAM WILL COME TRUE", [type]), { kind: "actionable", reason: "student-submission" }, type);
    }
    assert.deepEqual(classify("PRÁCTICA NÚMERO 3: SECCIÓN LONGITUDINAL DE LA PIEZA CREADA", ["online_upload", "none"], null), {
      kind: "actionable",
      reason: "student-submission",
    });
    assert.deepEqual(classify("Herramienta externa", ["external_tool"]), { kind: "actionable", reason: "external-tool" });
  });

  it("does not globally exclude on_paper: dated is actionable, undated needs review", () => {
    assert.deepEqual(classify("Examen parcial", ["on_paper"]), { kind: "actionable", reason: "on-paper-dated" });
    assert.deepEqual(classify("ENTREGA. EJERCICIO 3 maqueta", ["on_paper"]), { kind: "actionable", reason: "on-paper-dated" });
    assert.deepEqual(classify("Examen parcial", ["on_paper"], null), { kind: "needs-review", reason: "on-paper-undated" });
  });

  it("never imports `none` silently: review unless clearly administrative", () => {
    assert.deepEqual(classify("Extra Parcial 1", ["none"]), { kind: "needs-review", reason: "no-student-action" });
    assert.deepEqual(classify("Extra Parcial 1", ["online_upload"]), { kind: "actionable", reason: "student-submission" });
    assert.deepEqual(classify("Trabajo final", ["not_graded"]), { kind: "needs-review", reason: "no-student-action" });
    assert.deepEqual(classify("Trabajo final", []), { kind: "needs-review", reason: "no-student-action" });
    assert.deepEqual(classify("Trabajo final", null), { kind: "needs-review", reason: "unknown-type" });
    assert.deepEqual(classify("Trabajo final", ["wiki_page"]), { kind: "needs-review", reason: "unknown-type" });
  });

  it("does not reject exams, quizzes or exercises by keywords", () => {
    for (const title of ["Examen parcial", "Práctica 3", "Actividad 1", "Entrega ejercicio", "Quiz Tema 4", "EXAMEN FINAL — NOTA MÍNIMA 5"]) {
      assert.equal(classify(title, ["online_quiz"]).kind, "actionable", title);
      assert.notEqual(classify(title, ["none"]).kind, "ignored-by-rule", title);
    }
  });

  it("is not swayed by grading metadata alone", () => {
    const base: Pick<CanvasAssignment, "name" | "dueAt" | "submissionTypes"> = { name: "Examen final", dueAt: DUE, submissionTypes: ["on_paper"] };
    assert.equal(classifyAssignment(base).kind, "actionable");
  });
});

// ---------------------------------------------------------------------------
// Per-assignment decisions
// ---------------------------------------------------------------------------

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function course(id: string): CanvasCourse {
  return { id, name: `Curso ${id}`, courseCode: null, workflowState: "available", startAt: null, endAt: null, term: null, enrollments: [], accessRestricted: false };
}

function canvasAssignment(id: string, name: string): CanvasAssignment {
  return {
    id,
    courseId: "145580",
    name,
    dueAt: null,
    unlockAt: null,
    lockAt: null,
    published: true,
    workflowState: null,
    createdAt: null,
    updatedAt: null,
    submission: null,
    submissionTypes: ["none"],
    gradingType: null,
    pointsPossible: null,
    omitFromFinalGrade: null,
  };
}

function harness(options: { overview?: CanvasOverview; links?: CanvasCourseLink[]; assignments?: AssignmentsRead; task?: CanvasTaskIdentity | null; removed?: number | null } = {}) {
  const saved: { courseId: string; assignmentId: string; state: string; name: string | null }[] = [];
  const deleted: string[] = [];
  let canvasCalls = 0;
  const deps: AssignmentDecisionDeps = {
    loadOverview: async () => {
      canvasCalls += 1;
      return (
        options.overview ?? { state: "connected", profile: { id: "1", name: "Ana", shortName: null }, courses: [course("145580")], restrictedCount: 0, skippedCount: 0, truncated: false }
      );
    },
    loadLinks: async () => ({
      ok: true,
      links: options.links ?? [{ id: uuid(1), canvas_course_id: "145580", project_id: uuid(2), state: "linked", canvas_course_name: null, canvas_course_code: null }],
    }),
    loadAssignments: async () => {
      canvasCalls += 1;
      return options.assignments ?? { ok: true, assignments: [canvasAssignment("9001", "  NOTAS   FINALES AUDS ")], malformed: 0, truncated: false };
    },
    loadTask: async () => (options.task === undefined ? { source: "canvas", externalId: "course:145580:assignment:9001", title: "NOTAS FINALES AUDS" } : options.task),
    store: {
      setPreference: async (courseId, assignmentId, state, name) => {
        saved.push({ courseId, assignmentId, state, name });
        return options.removed === undefined ? 1 : options.removed;
      },
      deletePreference: async (id) => {
        deleted.push(id);
        return true;
      },
    },
  };
  return { deps, saved, deleted, canvasCalls: () => canvasCalls };
}

describe("per-assignment decisions", () => {
  it("parses only well-formed Campus external ids", () => {
    assert.deepEqual(parseCanvasExternalId("course:145580:assignment:9001"), { courseId: "145580", assignmentId: "9001" });
    for (const bad of [null, "", "course:145580", "course:x:assignment:1", "course:1:assignment:1:extra", "manual:1"]) assert.equal(parseCanvasExternalId(bad), null);
  });

  it("ignore from the preview verifies Canvas and stores the name Canvas returns", async () => {
    const h = harness();
    assert.deepEqual(await applyAssignmentDecision(h.deps, { action: "ignore", courseId: "145580", assignmentId: "9001" }), { ok: true, removedTask: true });
    assert.deepEqual(h.saved, [{ courseId: "145580", assignmentId: "9001", state: "ignored", name: "NOTAS FINALES AUDS" }]);
  });

  it("include stores 'included' for a live assignment", async () => {
    const h = harness({ removed: 0 });
    assert.deepEqual(await applyAssignmentDecision(h.deps, { action: "include", courseId: "145580", assignmentId: "9001" }), { ok: true, removedTask: false });
    assert.equal(h.saved[0].state, "included");
  });

  it("refuses assignments, courses or links Canvas does not confirm", async () => {
    const cases: [ReturnType<typeof harness>, string, string][] = [
      [harness(), "145580", "424242"], // not in the course
      [harness(), "999", "9001"], // course not live
      [harness({ links: [] }), "145580", "9001"], // course not linked
      [harness({ links: [{ id: uuid(1), canvas_course_id: "145580", project_id: null, state: "ignored", canvas_course_name: null, canvas_course_code: null }] }), "145580", "9001"],
      [harness({ overview: { state: "error", kind: "unavailable", status: 503 } }), "145580", "9001"],
      [harness({ assignments: { ok: false } }), "145580", "9001"],
      [harness(), "../x", "9001"],
      [harness(), "145580", "9001; drop"],
    ];
    for (const [h, courseId, assignmentId] of cases) {
      const result = await applyAssignmentDecision(h.deps, { action: "ignore", courseId, assignmentId });
      assert.equal(result.ok, false, `${courseId}/${assignmentId}`);
      assert.equal(h.saved.length, 0);
    }
  });

  it("'Ignorar en TRAZA' uses the task's own identity, without calling Canvas", async () => {
    const h = harness();
    assert.deepEqual(await applyAssignmentDecision(h.deps, { action: "ignore-task", taskId: uuid(5) }), { ok: true, removedTask: true });
    assert.deepEqual(h.saved, [{ courseId: "145580", assignmentId: "9001", state: "ignored", name: "NOTAS FINALES AUDS" }]);
    assert.equal(h.canvasCalls(), 0);
  });

  it("'Ignorar en TRAZA' never applies to manual, foreign or malformed tasks", async () => {
    for (const task of [
      { source: "manual", externalId: null, title: "Comprar cartón" },
      { source: "manual", externalId: "course:145580:assignment:9001", title: "Disfrazada" },
      { source: "canvas", externalId: "evil", title: "x" },
      null, // not the caller's task (RLS) or missing
    ]) {
      const h = harness({ task });
      assert.equal((await applyAssignmentDecision(h.deps, { action: "ignore-task", taskId: uuid(5) })).ok, false);
      assert.equal(h.saved.length, 0);
    }
    const h = harness();
    assert.equal((await applyAssignmentDecision(h.deps, { action: "ignore-task", taskId: "not-a-uuid" })).ok, false);
  });

  it("restore deletes only the decision, by id", async () => {
    const h = harness();
    assert.deepEqual(await applyAssignmentDecision(h.deps, { action: "restore", preferenceId: uuid(7) }), { ok: true, removedTask: false });
    assert.deepEqual([h.deleted, h.saved.length, h.canvasCalls()], [[uuid(7)], 0, 0]);
    assert.equal((await applyAssignmentDecision(h.deps, { action: "restore", preferenceId: "1" })).ok, false);
  });

  it("reports a failed save", async () => {
    const h = harness({ removed: null });
    assert.deepEqual(await applyAssignmentDecision(h.deps, { action: "ignore-task", taskId: uuid(5) }), { ok: false, error: "No se ha podido guardar." });
  });
});
