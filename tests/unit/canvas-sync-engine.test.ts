// The Canvas sync engine with a mocked Canvas and store: authenticity, classification groups,
// durable user decisions, preview counts and failure handling. Fake fixtures only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignmentExternalId, type CanvasTaskWrite } from "@/lib/canvas/assignments";
import type { CanvasCourseLink } from "@/lib/canvas/mapping";
import type { CanvasOverview } from "@/lib/canvas/read";
import {
  UPSERT_BATCH_SIZE,
  runCanvasSync,
  type AssignmentPreference,
  type AssignmentsRead,
  type CanvasSyncSummary,
  type SyncDeps,
  type SyncItemGroup,
  type UpsertOutcome,
} from "@/lib/canvas/sync";
import { courseReportLine, itemLine, omittedFootnote, previewTotalsLine, syncTotalsLine, syncWarnings } from "@/lib/canvas/sync-format";
import type { CanvasAssignment, CanvasCourse } from "@/lib/canvas/types";

const FAKE_TOKEN = "1234~FAKE-test-token-not-real-0000";
const TODAY = "2026-10-06";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function assignment(id: string, name: string, overrides: Partial<CanvasAssignment> = {}): CanvasAssignment {
  return {
    id,
    courseId: "145580",
    name,
    dueAt: "2026-10-12T22:59:00Z",
    unlockAt: null,
    lockAt: null,
    published: true,
    workflowState: null,
    createdAt: "2026-09-20T10:00:00Z",
    updatedAt: null,
    submission: null,
    submissionTypes: ["online_upload"],
    gradingType: "points",
    pointsPossible: 10,
    omitFromFinalGrade: false,
    ...overrides,
  };
}

/** A realistic course: real work, gradebook and attendance columns, an ambiguous item, old history. */
const campusCourse: CanvasAssignment[] = [
  assignment("1", "ENTREGA ACTIVIDAD 1: MY DREAM WILL COME TRUE"),
  assignment("2", "PRÁCTICA NÚMERO 3: SECCIÓN LONGITUDINAL DE LA PIEZA CREADA", { submissionTypes: ["online_upload"] }),
  assignment("3", "Examen parcial", { submissionTypes: ["on_paper"] }),
  assignment("4", "NOTAS FINALES AUDS", { submissionTypes: ["none"], dueAt: null }),
  assignment("5", "[C.E] Notas Finales", { submissionTypes: ["none"], dueAt: null }),
  assignment("6", "Roll Call Attendance", { submissionTypes: ["external_tool"], dueAt: null }),
  assignment("7", "Extra Parcial 1", { submissionTypes: ["none"] }),
  assignment("8", "Entrega 2019", { dueAt: "2019-05-01T10:00:00Z" }),
  assignment("9", "Borrador", { published: false }),
];

function course(id: string, name: string): CanvasCourse {
  return { id, name, courseCode: null, workflowState: "available", startAt: null, endAt: null, term: null, enrollments: [], accessRestricted: false };
}

const connected = (courses: CanvasCourse[]): CanvasOverview => ({
  state: "connected",
  profile: { id: "1", name: "Ana", shortName: null },
  courses,
  restrictedCount: 0,
  skippedCount: 0,
  truncated: false,
});

function link(courseId: string, state: "linked" | "ignored", projectId: string | null, name = `Curso ${courseId}`): CanvasCourseLink {
  return { id: uuid(Number(courseId)), canvas_course_id: courseId, project_id: projectId, state, canvas_course_name: name, canvas_course_code: null };
}

function harness(options: {
  overview?: CanvasOverview;
  links?: CanvasCourseLink[] | null;
  assignments?: Record<string, AssignmentsRead>;
  preferences?: AssignmentPreference[] | null;
  existing?: Set<string> | null;
  failUpsert?: (courseId: string, call: number) => boolean;
}) {
  const fetched: string[] = [];
  const upserts: { courseId: string; writes: CanvasTaskWrite[] }[] = [];
  const stored = new Set<string>(options.existing ?? []);
  const preferences = options.preferences === null ? null : [...(options.preferences ?? [])];
  let linksLoaded = 0;
  const ignored = () => new Set((preferences ?? []).filter((p) => p.state === "ignored").map((p) => `${p.canvas_course_id}:${p.canvas_assignment_id}`));
  const deps: SyncDeps = {
    loadOverview: async () => options.overview ?? connected([course("145580", "TALLER DE PROYECTOS G1"), course("145581", "DIBUJO III")]),
    loadLinks: async () => {
      linksLoaded += 1;
      return options.links === null ? { ok: false } : { ok: true, links: options.links ?? [link("145580", "linked", uuid(1))] };
    },
    loadProjectNames: async () => new Map([[uuid(1), "Taller de Proyectos"], [uuid(2), "Dibujo III"]]),
    loadAssignments: async (courseId) => {
      fetched.push(courseId);
      return options.assignments?.[courseId] ?? { ok: true, assignments: [assignment("7001", "Panel análisis territorial", { courseId })], malformed: 0, truncated: false };
    },
    loadPreferences: async () => (preferences === null ? null : [...preferences]),
    loadExistingExternalIds: async () => (options.existing === null ? null : new Set(stored)),
    upsertCourseTasks: async (courseId, writes) => {
      const call = upserts.filter((u) => u.courseId === courseId).length;
      upserts.push({ courseId, writes });
      if (options.failUpsert?.(courseId, call)) return null;
      // Mirrors the database: ignored assignments are never written.
      return writes.map((write): UpsertOutcome => {
        if (ignored().has(`${courseId}:${write.assignment_id}`)) return { assignment_id: write.assignment_id, outcome: "ignored" };
        const key = assignmentExternalId(courseId, write.assignment_id);
        const outcome = stored.has(key) ? "unchanged" : "created";
        stored.add(key);
        return { assignment_id: write.assignment_id, outcome };
      });
    },
    today: TODAY,
  };
  return { deps, fetched, upserts, stored, preferences, linksLoaded: () => linksLoaded };
}

const realCourse = { "145580": { ok: true, assignments: campusCourse, malformed: 0, truncated: false } as AssignmentsRead };
const titles = (summary: CanvasSyncSummary, group: SyncItemGroup) => summary.items.filter((item) => item.group === group).map((item) => item.title);
const pref = (assignmentId: string, state: "ignored" | "included"): AssignmentPreference => ({ canvas_course_id: "145580", canvas_assignment_id: assignmentId, state });

describe("Canvas sync: authenticity and scope", () => {
  it("writes nothing when Canvas is unavailable or not configured", async () => {
    for (const overview of [
      { state: "error", kind: "unavailable", status: 503 },
      { state: "error", kind: "unauthorized", status: 401 },
      { state: "not-configured", problem: "missing" },
    ] as CanvasOverview[]) {
      for (const mode of ["sync", "preview"] as const) {
        const h = harness({ overview });
        assert.equal((await runCanvasSync(h.deps, mode)).ok, false);
        assert.deepEqual([h.fetched.length, h.upserts.length, h.linksLoaded()], [0, 0, 0]);
      }
    }
  });

  it("skips a stored link whose course is not in the live Canvas response (kept, reported)", async () => {
    const h = harness({ links: [link("145580", "linked", uuid(1)), link("12345", "linked", uuid(2), "Curso inventado")] });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual(h.fetched, ["145580"]);
    assert.deepEqual(h.upserts.map((u) => u.courseId), ["145580"]);
    assert.equal(result.summary.coursesSkipped, 1);
    assert.deepEqual([result.summary.courses[1].status, result.summary.courses[1].courseName], ["not-in-canvas", "Curso inventado"]);
  });

  it("never syncs ignored or unmapped courses", async () => {
    const h = harness({ links: [link("145581", "ignored", null)] });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual([h.fetched, h.upserts, result.summary.coursesChecked], [[], [], 0]);
  });

  it("stops before writing if links, decisions or existing tasks cannot be read", async () => {
    for (const options of [{ links: null }, { preferences: null }, { existing: null }]) {
      for (const mode of ["sync", "preview"] as const) {
        const h = harness(options);
        assert.equal((await runCanvasSync(h.deps, mode)).ok, false);
        assert.deepEqual([h.fetched.length, h.upserts.length], [0, 0]);
      }
    }
  });
});

describe("Canvas sync: classification groups", () => {
  it("imports only actionable work; lists review and auto-omitted items; counts old history", async () => {
    const h = harness({ assignments: realCourse });
    const result = await runCanvasSync(h.deps, "preview");
    assert.ok(result.ok);
    const { summary } = result;
    assert.deepEqual(titles(summary, "import"), [
      "ENTREGA ACTIVIDAD 1: MY DREAM WILL COME TRUE",
      "PRÁCTICA NÚMERO 3: SECCIÓN LONGITUDINAL DE LA PIEZA CREADA",
      "Examen parcial",
    ]);
    assert.deepEqual(titles(summary, "review"), ["Extra Parcial 1"]);
    assert.deepEqual(titles(summary, "auto-ignored"), ["NOTAS FINALES AUDS", "[C.E] Notas Finales", "Roll Call Attendance"]);
    assert.deepEqual(titles(summary, "imported-review"), []);
    assert.deepEqual(
      [summary.toImport, summary.review, summary.omitted, summary.userIgnored, summary.assignmentsReceived],
      [3, 1, 5, 0, 9], // omitted = 3 rule-ignored + 1 old + 1 unpublished
    );
    assert.equal(previewTotalsLine(summary), "3 se importarían (3 nuevas · 0 ya importadas) · 1 requiere revisión · 5 omitidas");
    assert.equal(h.upserts.length, 0, "preview writes nothing");
  });

  it("sync writes only the actionable items, never unresolved review ones", async () => {
    const h = harness({ assignments: realCourse });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual(h.upserts[0].writes.map((w) => w.assignment_id), ["1", "2", "3"]);
    assert.equal(syncTotalsLine(result.summary), "3 nuevas · 0 actualizadas · 0 sin cambios · 1 requiere revisión · 5 omitidas");
  });

  it("imports a review item once the user included it", async () => {
    const h = harness({ assignments: realCourse, preferences: [pref("7", "included")] });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual(h.upserts[0].writes.map((w) => w.assignment_id), ["1", "2", "3", "7"]);
    const included = result.summary.items.find((item) => item.assignmentId === "7");
    assert.deepEqual([included?.group, included?.included], ["import", true]);
    assert.equal(itemLine(included!), "TALLER DE PROYECTOS G1 → Taller de Proyectos · Importada por ti");
  });

  it("'included' never overrides an automatic gradebook/attendance rule", async () => {
    const h = harness({ assignments: realCourse, preferences: [pref("4", "included")] });
    await runCanvasSync(h.deps, "sync");
    assert.ok(!h.upserts[0].writes.some((w) => w.assignment_id === "4"));
  });

  it("an assignment the user ignored is never sent, listed or recreated, however many syncs run", async () => {
    const h = harness({ assignments: realCourse, preferences: [pref("1", "ignored"), pref("7", "ignored")] });
    for (let run = 0; run < 5; run++) {
      const result = await runCanvasSync(h.deps, "sync");
      assert.ok(result.ok);
      assert.equal(result.summary.userIgnored, 2);
      assert.ok(!result.summary.items.some((item) => item.assignmentId === "1" || item.assignmentId === "7"));
    }
    assert.ok(h.upserts.every((u) => u.writes.every((w) => w.assignment_id !== "1")));
    assert.ok(!h.stored.has(assignmentExternalId("145580", "1")));
  });

  it("a restored (no longer ignored) assignment becomes eligible again", async () => {
    const h = harness({ assignments: realCourse, preferences: [pref("1", "ignored")] });
    await runCanvasSync(h.deps, "sync");
    h.preferences!.length = 0; // Restaurar
    const result = await runCanvasSync(h.deps, "preview");
    assert.ok(result.ok);
    assert.ok(titles(result.summary, "import").includes("ENTREGA ACTIVIDAD 1: MY DREAM WILL COME TRUE"));
  });

  it("flags already imported false positives for review, never deletes or rewrites them", async () => {
    const existing = new Set([assignmentExternalId("145580", "4"), assignmentExternalId("145580", "6"), assignmentExternalId("145580", "7"), assignmentExternalId("145580", "1")]);
    const h = harness({ assignments: realCourse, existing });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual(titles(result.summary, "imported-review"), ["NOTAS FINALES AUDS", "Roll Call Attendance", "Extra Parcial 1"]);
    assert.deepEqual(h.upserts[0].writes.map((w) => w.assignment_id), ["1", "2", "3"]);
    assert.equal(h.stored.size, 6, "nothing removed: 4 existing + 2 created");
    assert.equal(result.summary.importedReview, 3);
    assert.deepEqual(syncWarnings(result.summary), ["3 tareas importadas antes ya no se importarían. Revísalas: no se borran solas."]);
    assert.equal(itemLine(result.summary.items.find((item) => item.assignmentId === "4")!), "TALLER DE PROYECTOS G1 → Taller de Proyectos · Elemento de calificación");
  });

  it("counts a database-side 'ignored' outcome (ignored during the sync) as ignored by the user", async () => {
    const h = harness({ assignments: realCourse });
    // Ignored after the preferences were read: only the database knows.
    const upsert = h.deps.upsertCourseTasks;
    h.deps.upsertCourseTasks = async (courseId, writes) => {
      h.preferences!.push(pref("2", "ignored"));
      return upsert(courseId, writes);
    };
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual([result.summary.created, result.summary.userIgnored], [2, 1]);
  });
});

describe("Canvas sync: preview counts and failures", () => {
  const twoCourses = [link("145580", "linked", uuid(1)), link("145581", "linked", uuid(2))];

  it("preview splits new from already imported, per course", async () => {
    const h = harness({ links: twoCourses, existing: new Set([assignmentExternalId("145581", "7001")]) });
    const result = await runCanvasSync(h.deps, "preview");
    assert.ok(result.ok);
    assert.deepEqual([result.summary.toCreate, result.summary.existing, result.summary.toImport], [1, 1, 2]);
    assert.deepEqual(result.summary.courses.map((c) => [c.courseName, c.projectName, c.status]), [
      ["TALLER DE PROYECTOS G1", "Taller de Proyectos", "previewed"],
      ["DIBUJO III", "Dibujo III", "previewed"],
    ]);
  });

  it("sync imports once: a second run reports unchanged", async () => {
    const h = harness({ links: twoCourses });
    const first = await runCanvasSync(h.deps, "sync");
    const second = await runCanvasSync(h.deps, "sync");
    assert.ok(first.ok && second.ok);
    assert.deepEqual([first.summary.created, second.summary.created, second.summary.unchanged], [2, 0, 2]);
  });

  it("keeps going when one course cannot be read", async () => {
    const h = harness({ links: twoCourses, assignments: { "145580": { ok: false } } });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual(h.upserts.map((u) => u.courseId), ["145581"]);
    assert.deepEqual([result.summary.coursesFailed, result.summary.errors, result.summary.created], [1, 1, 1]);
  });

  it("counts malformed rows as omitted and syncs the rest", async () => {
    const h = harness({ assignments: { "145580": { ok: true, assignments: [assignment("1", "Entrega")], malformed: 2, truncated: false } } });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual([result.summary.created, result.summary.omitted, result.summary.assignmentsReceived], [1, 2, 3]);
  });

  it("writes in batches, keeps committed batches and reports a failed one", async () => {
    const many = Array.from({ length: 450 }, (_, i) => assignment(String(i + 1), `Entrega ${i + 1}`));
    const h = harness({ assignments: { "145580": { ok: true, assignments: many, malformed: 0, truncated: false } }, failUpsert: (_, call) => call === 2 });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual(h.upserts.map((u) => u.writes.length), [UPSERT_BATCH_SIZE, UPSERT_BATCH_SIZE, 50]);
    assert.deepEqual([result.summary.created, result.summary.coursesFailed, result.summary.courses[0].status], [400, 1, "failed"]);
  });

  it("keeps the submission rule: only proven submissions are sent as done", async () => {
    const h = harness({
      assignments: {
        "145580": {
          ok: true,
          assignments: [
            assignment("1", "A", { submission: { workflowState: "submitted", submittedAt: "2026-10-05T10:00:00Z", excused: false } }),
            assignment("2", "B", { submission: { workflowState: "graded", submittedAt: null, excused: false } }),
          ],
          malformed: 0,
          truncated: false,
        },
      },
    });
    await runCanvasSync(h.deps, "sync");
    assert.deepEqual(h.upserts[0].writes.map((w) => w.submitted), [true, false]);
  });

  it("explains courses and warnings without exposing details", async () => {
    const h = harness({ links: [link("145580", "linked", uuid(1)), link("145581", "linked", uuid(2)), link("999", "linked", uuid(2))], assignments: { ...realCourse, "145581": { ok: false } } });
    const result = await runCanvasSync(h.deps, "sync");
    assert.ok(result.ok);
    assert.deepEqual(result.summary.courses.map(courseReportLine), [
      "9 entregas · 3 nuevas · 0 actualizadas · 0 sin cambios · 1 requiere revisión · 5 omitidas",
      "No se han podido leer sus entregas",
      "No visible en Campus · se omite, el vínculo se conserva",
    ]);
    assert.deepEqual(syncWarnings(result.summary), [
      "1 curso no se ha podido sincronizar. Lo demás se ha guardado.",
      "1 curso vinculado ya no aparece en Campus y se ha omitido.",
    ]);
  });

  it("words the omitted footnote with correct plurals", () => {
    assert.equal(omittedFootnote(1, 22), "1 ignorada por ti · 22 antiguas, no publicadas o ilegibles");
    assert.equal(omittedFootnote(2, 1), "2 ignoradas por ti · 1 antigua, no publicada o ilegible");
    assert.equal(omittedFootnote(0, 0), "");
  });

  it("returns no token or URLs, and Canvas ids only in the action fields", async () => {
    const h = harness({ assignments: realCourse });
    const result = await runCanvasSync(h.deps, "preview");
    assert.ok(result.ok);
    const serialized = JSON.stringify(result);
    for (const secret of [FAKE_TOKEN, "http", uuid(1)]) assert.ok(!serialized.includes(secret), secret);
    for (const item of result.summary.items) assert.ok(!itemLine(item).includes("145580"));
    for (const course of result.summary.courses) assert.ok(!courseReportLine(course).includes("145580"));
  });
});
