// Canvas course -> project mapping rules and the decision engine behind the Server Actions, with a
// mocked Canvas overview and an in-memory store. No network, no real token, no database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCourseDecision, type DecisionDeps, type DecisionWrite } from "@/lib/canvas/decisions";
import {
  buildCourseMapping,
  courseSnapshot,
  normalizeCourseName,
  proposedProjectName,
  resolveCourseForMapping,
  suggestProject,
  type CanvasCourseLink,
  type CourseSnapshot,
} from "@/lib/canvas/mapping";
import type { CanvasOverview } from "@/lib/canvas/read";
import type { CanvasCourse } from "@/lib/canvas/types";
import { withTaskCounts } from "@/lib/projects/projects";
import type { NewProjectDetails } from "@/lib/projects/validation";
import type { ProjectOption } from "@/lib/projects/types";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function course(id: string, name: string | null, courseCode: string | null = null): CanvasCourse {
  return { id, name, courseCode, workflowState: "available", startAt: null, endAt: null, term: null, enrollments: [], accessRestricted: false };
}

const projects: ProjectOption[] = [
  { id: uuid(1), name: "Taller de Proyectos", status: "active" },
  { id: uuid(2), name: "Taller de Dibujo Integrado III", status: "planned" },
  { id: uuid(3), name: "Archivo académico", status: "archived" },
  { id: uuid(4), name: "Astronomía", status: "active" },
];

const connected = (courses: CanvasCourse[]): CanvasOverview => ({
  state: "connected",
  profile: { id: "42", name: "Ana", shortName: null },
  courses,
  restrictedCount: 0,
  skippedCount: 0,
  truncated: false,
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe("conservative name matching", () => {
  it("normalises accents, case, bracketed codes and trailing group markers", () => {
    assert.equal(normalizeCourseName("Taller de Dibujo Integrado III (M21-9947 M2R-9947)"), "taller de dibujo integrado iii");
    assert.equal(normalizeCourseName("TALLER DE PROYECTOS G1"), "taller de proyectos");
    assert.equal(normalizeCourseName("Taller de proyectos - Grupo 2"), "taller de proyectos");
    assert.equal(normalizeCourseName("Astronomía [2026-27]"), "astronomia");
    // Numbers that are part of the subject are kept.
    assert.equal(normalizeCourseName("Estructuras 2"), "estructuras 2");
  });

  it("suggests a project only for a unique exact normalised match among active/planned projects", () => {
    assert.equal(suggestProject(course("1", "Taller de Dibujo Integrado III (M21-9947 M2R-9947)"), projects)?.id, uuid(2));
    assert.equal(suggestProject(course("2", "TALLER DE PROYECTOS G1"), projects)?.id, uuid(1));
    // Archived projects are never suggested; partial names never match.
    assert.equal(suggestProject(course("3", "Archivo académico"), projects), null);
    assert.equal(suggestProject(course("4", "Taller"), projects), null);
    assert.equal(suggestProject(course("5", "Biblioteca · Competencias informacionales"), projects), null);
    assert.equal(suggestProject(course("6", null), projects), null);
    // Ambiguous: two projects with the same normalised name → no suggestion.
    assert.equal(suggestProject(course("7", "Astronomía"), [...projects, { id: uuid(9), name: "ASTRONOMIA", status: "active" }]), null);
  });

  it("proposes an editable project name without trailing codes", () => {
    assert.equal(proposedProjectName(course("1", "Taller de Dibujo Integrado III (M21-9947 M2R-9947)")), "Taller de Dibujo Integrado III");
    assert.equal(proposedProjectName(course("1", "Historia (A) [2026]")), "Historia");
    assert.equal(proposedProjectName(course("1", "TALLER DE PROYECTOS G1")), "TALLER DE PROYECTOS G1");
    assert.equal(proposedProjectName(course("1", "(Solo código)")), "(Solo código)");
    assert.equal(proposedProjectName(course("77", null, "TP-1")), "TP-1");
    assert.equal(proposedProjectName(course("77", null)), "Curso 77");
    assert.equal([...proposedProjectName(course("1", "x".repeat(300)))].length, 120);
  });
});

describe("classification", () => {
  const courses = [course("100", "Taller de Proyectos G1"), course("200", "Biblioteca"), course("300", "Astronomía"), course("400", "Empleabilidad")];
  const links: CanvasCourseLink[] = [
    { id: uuid(11), canvas_course_id: "100", project_id: uuid(1), state: "linked", canvas_course_name: "Taller de Proyectos G1", canvas_course_code: null },
    { id: uuid(12), canvas_course_id: "200", project_id: null, state: "ignored", canvas_course_name: "Biblioteca", canvas_course_code: null },
    { id: uuid(13), canvas_course_id: "999", project_id: uuid(4), state: "linked", canvas_course_name: "Curso antiguo", canvas_course_code: "OLD" },
  ];

  it("splits courses into linked, ignored and unmapped (no row), plus decisions Canvas no longer lists", () => {
    const mapping = buildCourseMapping(courses, links, projects);
    assert.deepEqual(mapping.linked.map((e) => [e.course.id, e.project?.name]), [["100", "Taller de Proyectos"]]);
    assert.deepEqual(mapping.ignored.map((e) => e.course.id), ["200"]);
    assert.deepEqual(mapping.unmapped.map((e) => [e.course.id, e.suggestion?.name ?? null]), [
      ["300", "Astronomía"],
      ["400", null],
    ]);
    assert.deepEqual(mapping.missing.map((l) => l.canvas_course_id), ["999"]);
  });

  it("matches by course id, never by name", () => {
    const renamed = [course("100", "Nombre totalmente distinto")];
    assert.equal(buildCourseMapping(renamed, links, projects).linked[0].course.id, "100");
    const sameNameOtherId = [course("101", "Taller de Proyectos G1")];
    assert.equal(buildCourseMapping(sameNameOtherId, links, projects).unmapped.length, 1);
  });

  it("derives the CAMPUS label from links, not from a stored flag", () => {
    const summary = { name: "x", area: null, description: null, status: "active", progress: 0, created_at: "2026-10-01T00:00:00Z" };
    const result = withTaskCounts([{ id: uuid(1), ...summary }, { id: uuid(2), ...summary }], [], new Set([uuid(1)]));
    assert.deepEqual(result.map((p) => p.campusLinked), [true, false]);
    assert.deepEqual(withTaskCounts([{ id: uuid(1), ...summary }], []).map((p) => p.campusLinked), [false]);
  });
});

describe("server-side course authenticity", () => {
  const overview = connected([course("145580", "TALLER DE PROYECTOS G1", "TP-G1")]);

  it("accepts only a course id present in the server-side Canvas result", () => {
    assert.ok(resolveCourseForMapping("145580", overview).ok);
    assert.deepEqual(resolveCourseForMapping("12345", overview), { ok: false, error: "Este curso no está entre tus cursos activos de Campus Virtual." });
    for (const bad of [undefined, 145580, "", "145580 ", "abc", "1".repeat(21)]) {
      assert.equal(resolveCourseForMapping(bad, overview).ok, false, String(bad));
    }
  });

  it("refuses to decide while Campus is unavailable or not configured", () => {
    assert.deepEqual(resolveCourseForMapping("145580", { state: "error", kind: "unavailable", status: null }), {
      ok: false,
      error: "Campus Virtual no está disponible en este momento.",
    });
    assert.deepEqual(resolveCourseForMapping("145580", { state: "error", kind: "unauthorized", status: 401 }), {
      ok: false,
      error: "No se ha podido autenticar con Campus Virtual.",
    });
    assert.deepEqual(resolveCourseForMapping("145580", { state: "not-configured", problem: "missing" }), { ok: false, error: "Canvas no está configurado." });
  });

  it("builds the stored snapshot from Canvas data, clipped to the column limits", () => {
    assert.deepEqual(courseSnapshot(course("1", ` ${"N".repeat(400)} `, " TP ")), {
      canvas_course_id: "1",
      canvas_course_name: "N".repeat(300),
      canvas_course_code: "TP",
    });
  });
});

/** A recording store, so tests can assert exactly what would be written. */
function harness(overview: CanvasOverview, ok = true) {
  const saved: DecisionWrite[] = [];
  const created: { snapshot: CourseSnapshot; project: NewProjectDetails }[] = [];
  const cleared: string[] = [];
  let canvasCalls = 0;
  const deps: DecisionDeps = {
    loadOverview: async () => {
      canvasCalls += 1;
      return overview;
    },
    store: {
      saveDecision: async (write) => (saved.push(write), ok),
      createProjectWithLink: async (snapshot, project) => (created.push({ snapshot, project }), ok),
      clearDecision: async (courseId) => (cleared.push(courseId), ok),
    },
  };
  return { deps, saved, created, cleared, calls: () => canvasCalls };
}

describe("course decisions (Server Action logic)", () => {
  const overview = connected([course("145580", "TALLER DE PROYECTOS G1", "TP-G1")]);

  it("links using Canvas metadata from the server, ignoring browser-supplied names", async () => {
    const h = harness(overview);
    const result = await applyCourseDecision(h.deps, {
      action: "link",
      courseId: "145580",
      formData: form({ project_id: uuid(1), canvas_course_name: "Nombre falso", canvas_course_code: "FAKE", user_id: uuid(9) }),
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(h.saved, [
      { canvas_course_id: "145580", canvas_course_name: "TALLER DE PROYECTOS G1", canvas_course_code: "TP-G1", state: "linked", project_id: uuid(1) },
    ]);
  });

  it("rejects a course id the user's Canvas did not return, writing nothing", async () => {
    const h = harness(overview);
    for (const action of ["link", "ignore", "create-project"] as const) {
      const input =
        action === "ignore"
          ? { action, courseId: "12345" }
          : { action, courseId: "12345", formData: form({ project_id: uuid(1), name: "Proyecto" }) };
      const result = await applyCourseDecision(h.deps, input);
      assert.deepEqual(result, { ok: false, error: "Este curso no está entre tus cursos activos de Campus Virtual." }, action);
    }
    assert.equal(h.saved.length + h.created.length + h.cleared.length, 0);
  });

  it("ignores with no project, from server metadata", async () => {
    const h = harness(overview);
    assert.deepEqual(await applyCourseDecision(h.deps, { action: "ignore", courseId: "145580" }), { ok: true });
    assert.deepEqual(h.saved[0], { canvas_course_id: "145580", canvas_course_name: "TALLER DE PROYECTOS G1", canvas_course_code: "TP-G1", state: "ignored", project_id: null });
  });

  it("requires a valid project to link, before calling Canvas", async () => {
    const h = harness(overview);
    assert.deepEqual(await applyCourseDecision(h.deps, { action: "link", courseId: "145580", formData: form({ project_id: "" }) }), {
      ok: false,
      error: "Elige un proyecto.",
    });
    assert.equal((await applyCourseDecision(h.deps, { action: "link", courseId: "145580", formData: form({ project_id: "taller" }) })).ok, false);
    assert.equal(h.calls(), 0);
    assert.equal(h.saved.length, 0);
  });

  it("creates a project + link from the user's edited fields and Canvas's course data", async () => {
    const h = harness(overview);
    const result = await applyCourseDecision(h.deps, {
      action: "create-project",
      courseId: "145580",
      formData: form({ name: " Taller de Proyectos ", area: "", description: "", status: "active", progress: "90", source: "canvas" }),
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(h.created, [
      {
        snapshot: { canvas_course_id: "145580", canvas_course_name: "TALLER DE PROYECTOS G1", canvas_course_code: "TP-G1" },
        project: { name: "Taller de Proyectos", area: null, description: null, status: "active" },
      },
    ]);
    const invalid = await applyCourseDecision(h.deps, { action: "create-project", courseId: "145580", formData: form({ name: "  " }) });
    assert.equal(invalid.ok, false);
    assert.equal(h.created.length, 1);
  });

  it("never writes or deletes anything when Campus is unavailable", async () => {
    const h = harness({ state: "error", kind: "unavailable", status: null });
    for (const input of [
      { action: "link" as const, courseId: "145580", formData: form({ project_id: uuid(1) }) },
      { action: "ignore" as const, courseId: "145580" },
      { action: "create-project" as const, courseId: "145580", formData: form({ name: "x" }) },
    ]) {
      assert.deepEqual(await applyCourseDecision(h.deps, input), { ok: false, error: "Campus Virtual no está disponible en este momento." });
    }
    assert.equal(h.saved.length + h.created.length + h.cleared.length, 0);
  });

  it("clears (unlink / restore) without needing Canvas, and validates the id", async () => {
    const h = harness({ state: "error", kind: "unavailable", status: null });
    assert.deepEqual(await applyCourseDecision(h.deps, { action: "clear", courseId: "145580" }), { ok: true });
    assert.deepEqual(h.cleared, ["145580"]);
    assert.equal(h.calls(), 0);
    assert.equal((await applyCourseDecision(h.deps, { action: "clear", courseId: "1; drop table" })).ok, false);
  });

  it("reports store failures with fixed messages", async () => {
    const h = harness(overview, false);
    assert.deepEqual(await applyCourseDecision(h.deps, { action: "ignore", courseId: "145580" }), { ok: false, error: "No se ha podido guardar." });
    assert.deepEqual(await applyCourseDecision(h.deps, { action: "create-project", courseId: "145580", formData: form({ name: "x" }) }), {
      ok: false,
      error: "No se ha podido crear el proyecto.",
    });
  });
});
