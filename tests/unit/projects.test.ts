import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countActiveProjects,
  countTasksByProject,
  distinctAreas,
  filterProjects,
  projectChoices,
  resolveProjectFilter,
  sortProjects,
  withTaskCounts,
} from "@/lib/projects/projects";
import type { ProjectOption, ProjectSummary } from "@/lib/projects/types";
import {
  isProjectId,
  parseArea,
  parseDescription,
  parseNewProject,
  parseProgress,
  parseProjectDetails,
  parseProjectName,
  parseProjectStatus,
} from "@/lib/projects/validation";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function project(n: number, status: string, created_at: string, area: string | null = null): ProjectSummary {
  return { id: id(n), name: `P${n}`, area, description: null, status, progress: 0, created_at };
}

describe("project validation", () => {
  it("trims names and enforces 1–120 characters", () => {
    assert.deepEqual(parseProjectName("  Taller de Proyectos "), { ok: true, value: "Taller de Proyectos" });
    assert.equal(parseProjectName("   ").ok, false);
    assert.equal(parseProjectName("ñ".repeat(120)).ok, true);
    assert.equal(parseProjectName("a".repeat(121)).ok, false);
  });

  it("makes area and description optional, trimmed and capped", () => {
    assert.deepEqual(parseArea("  "), { ok: true, value: null });
    assert.deepEqual(parseArea(" Arquitectura "), { ok: true, value: "Arquitectura" });
    assert.equal(parseArea("a".repeat(61)).ok, false);
    assert.deepEqual(parseDescription(""), { ok: true, value: null });
    assert.equal(parseDescription("a".repeat(2000)).ok, true);
    assert.equal(parseDescription("a".repeat(2001)).ok, false);
  });

  it("accepts only active, planned or archived, defaulting to active", () => {
    assert.deepEqual(parseProjectStatus(""), { ok: true, value: "active" });
    assert.deepEqual(parseProjectStatus("archived"), { ok: true, value: "archived" });
    assert.equal(parseProjectStatus("done").ok, false);
  });

  it("accepts progress only as a whole number 0–100", () => {
    assert.deepEqual(parseProgress("0"), { ok: true, value: 0 });
    assert.deepEqual(parseProgress(" 68 "), { ok: true, value: 68 });
    assert.deepEqual(parseProgress("100"), { ok: true, value: 100 });
    for (const bad of ["", "101", "-1", "12.5", "1e2", "abc", "0x10", "1000"]) {
      assert.equal(parseProgress(bad).ok, false, bad);
    }
  });

  it("creates with name, area, description and status only", () => {
    const parsed = parseNewProject(
      form({ name: "TRAZA", area: "", description: " App ", user_id: id(9), source: "ai", progress: "50", id: id(1) }),
    );
    assert.deepEqual(parsed, { ok: true, value: { name: "TRAZA", area: null, description: "App", status: "active" } });
  });

  it("edits the same fields plus progress, and requires a valid progress", () => {
    assert.deepEqual(parseProjectDetails(form({ name: "TRAZA", status: "archived", progress: "100" })), {
      ok: true,
      value: { name: "TRAZA", area: null, description: null, status: "archived", progress: 100 },
    });
    assert.equal(parseProjectDetails(form({ name: "TRAZA" })).ok, false);
  });

  it("validates project ids as UUIDs, rejecting the old mock slugs", () => {
    assert.equal(isProjectId(id(1)), true);
    assert.equal(isProjectId("taller-proyectos"), false);
  });
});

describe("project index helpers", () => {
  const projects = [
    project(1, "archived", "2025-09-01T00:00:00Z", "Universidad"),
    project(2, "planned", "2026-09-28T00:00:00Z", "arquitectura"),
    project(3, "active", "2026-09-15T00:00:00Z", "Arquitectura"),
    project(4, "active", "2026-09-14T00:00:00Z"),
  ];

  it("orders in course, planned, archived; oldest first within each", () => {
    assert.deepEqual(sortProjects(projects).map((p) => p.name), ["P4", "P3", "P2", "P1"]);
  });

  it("filters by status and counts each filter", () => {
    const counts = [undefined, "activos", "planificados", "archivados"].map(
      (slug) => filterProjects(projects, resolveProjectFilter(slug)).length,
    );
    assert.deepEqual(counts, [4, 2, 1, 1]);
    assert.equal(resolveProjectFilter("unknown").status, null);
  });

  it("derives total and pending task counts per project", () => {
    const tasks = [
      { project_id: id(3), status: "pending" },
      { project_id: id(3), status: "done" },
      { project_id: id(3), status: "pending" },
      { project_id: id(2), status: "done" },
      { project_id: null, status: "pending" },
    ];
    assert.deepEqual(countTasksByProject(tasks).get(id(3)), { taskCount: 3, pendingTaskCount: 2 });
    const counted = withTaskCounts(projects, tasks);
    assert.deepEqual(
      counted.map((p) => [p.name, p.taskCount, p.pendingTaskCount]),
      [
        ["P1", 0, 0],
        ["P2", 1, 0],
        ["P3", 3, 2],
        ["P4", 0, 0],
      ],
    );
  });

  it("suggests each area once, case-insensitively", () => {
    assert.deepEqual(distinctAreas(projects), ["arquitectura", "Universidad"]);
  });
});

describe("task project choices", () => {
  const options: ProjectOption[] = [
    { id: id(1), name: "Archivo académico", status: "archived" },
    { id: id(2), name: "Portfolio", status: "planned" },
    { id: id(3), name: "Taller de Proyectos", status: "active" },
  ];

  it("offers active and planned projects, never archived ones for new tasks", () => {
    assert.deepEqual(projectChoices(options, null).map((p) => p.name), ["Portfolio", "Taller de Proyectos"]);
  });

  it("keeps a task's current archived project selectable", () => {
    assert.deepEqual(projectChoices(options, id(1)).map((p) => p.name), ["Archivo académico", "Portfolio", "Taller de Proyectos"]);
  });

  it("counts only active projects for Home", () => {
    assert.equal(countActiveProjects(options), 1);
    assert.equal(countActiveProjects([]), 0);
  });
});
