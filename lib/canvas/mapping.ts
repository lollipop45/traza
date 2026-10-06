import { isAssignable } from "@/lib/projects/projects";
import type { ProjectOption } from "@/lib/projects/types";
import type { Tables } from "@/lib/supabase/database.types";
import type { CanvasOverview } from "./read";
import type { CanvasCourse } from "./types";

// Pure Canvas course <-> TRAZA project mapping logic. No data access here.

/** A row of `public.canvas_course_links`, exactly as generated from the database. */
export type CanvasCourseLinkRow = Tables<"canvas_course_links">;

export type CanvasCourseLink = Pick<
  CanvasCourseLinkRow,
  "id" | "canvas_course_id" | "project_id" | "state" | "canvas_course_name" | "canvas_course_code"
>;
export const CANVAS_COURSE_LINK_COLUMNS = "id, canvas_course_id, project_id, state, canvas_course_name, canvas_course_code";

/** Mirror the check constraints in 20261005172944_create_canvas_course_links.sql. */
const COURSE_NAME_MAX = 300;
const COURSE_CODE_MAX = 120;
const PROJECT_NAME_MAX = 120;

export function isCanvasCourseId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

/** What gets stored about a course: always derived from the server-side Canvas response. */
export type CourseSnapshot = {
  canvas_course_id: string;
  canvas_course_name: string | null;
  canvas_course_code: string | null;
};

function clip(value: string | null, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? [...trimmed].slice(0, max).join("") : null;
}

export function courseSnapshot(course: CanvasCourse): CourseSnapshot {
  return {
    canvas_course_id: course.id,
    canvas_course_name: clip(course.name, COURSE_NAME_MAX),
    canvas_course_code: clip(course.courseCode, COURSE_CODE_MAX),
  };
}

export type CourseResolution = { ok: true; course: CanvasCourse } | { ok: false; error: string };

/**
 * The authenticity check behind every mapping write: the course id the browser sent must be one
 * of the courses Canvas returned for this account, read on the server just now. Browser-supplied
 * names or codes are never used.
 */
export function resolveCourseForMapping(courseId: unknown, overview: CanvasOverview): CourseResolution {
  if (!isCanvasCourseId(courseId)) return { ok: false, error: "El curso no es válido." };
  if (overview.state === "not-configured") return { ok: false, error: "Canvas no está configurado." };
  if (overview.state === "error") {
    return {
      ok: false,
      error: overview.kind === "unauthorized" ? "No se ha podido autenticar con Campus Virtual." : "Campus Virtual no está disponible en este momento.",
    };
  }
  const course = overview.courses.find((candidate) => candidate.id === courseId);
  return course ? { ok: true, course } : { ok: false, error: "Este curso no está entre tus cursos activos de Campus Virtual." };
}

/**
 * Conservative comparison key: lowercase, no accents, no bracketed segments ("(M21-9947)"), no
 * trailing group marker ("G1", "Grupo 2"), punctuation collapsed. "Taller de Dibujo Integrado III
 * (M21-9947 M2R-9947)" and "Taller de Dibujo Integrado III" share a key; different subjects never do.
 */
export function normalizeCourseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+(g|gr|grupo)\s*\d+$/, "")
    .trim();
}

/**
 * A suggested project for an unmapped course: only when exactly one active/planned project has the
 * same normalised name. Never saved without the user's confirmation.
 */
export function suggestProject(course: Pick<CanvasCourse, "name">, projects: ProjectOption[]): ProjectOption | null {
  if (!course.name) return null;
  const key = normalizeCourseName(course.name);
  if (!key) return null;
  const matches = projects.filter((project) => isAssignable(project) && normalizeCourseName(project.name) === key);
  return matches.length === 1 ? matches[0] : null;
}

/** Prefill for "Crear proyecto": the course name without trailing bracketed codes. Editable. */
export function proposedProjectName(course: Pick<CanvasCourse, "name" | "courseCode" | "id">): string {
  const base = course.name ?? course.courseCode ?? `Curso ${course.id}`;
  let name = base.trim();
  for (let previous = ""; previous !== name; ) {
    previous = name;
    name = name.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/, "").trim();
  }
  return [...(name || base.trim())].slice(0, PROJECT_NAME_MAX).join("");
}

export type CourseMappingEntry =
  | { state: "unmapped"; course: CanvasCourse; suggestion: ProjectOption | null }
  | { state: "linked"; course: CanvasCourse; link: CanvasCourseLink; project: ProjectOption | null }
  | { state: "ignored"; course: CanvasCourse; link: CanvasCourseLink };

export type CourseMapping = {
  unmapped: Extract<CourseMappingEntry, { state: "unmapped" }>[];
  linked: Extract<CourseMappingEntry, { state: "linked" }>[];
  ignored: Extract<CourseMappingEntry, { state: "ignored" }>[];
  /** Decisions about courses Canvas no longer lists as active (shown from the snapshot). */
  missing: CanvasCourseLink[];
};

/** Classifies every current Canvas course by its stored decision (no row = unmapped). */
export function buildCourseMapping(courses: CanvasCourse[], links: CanvasCourseLink[], projects: ProjectOption[]): CourseMapping {
  const linksByCourse = new Map(links.map((link) => [link.canvas_course_id, link]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const mapping: CourseMapping = { unmapped: [], linked: [], ignored: [], missing: [] };

  for (const course of courses) {
    seen.add(course.id);
    const link = linksByCourse.get(course.id);
    if (!link) mapping.unmapped.push({ state: "unmapped", course, suggestion: suggestProject(course, projects) });
    else if (link.state === "linked") {
      mapping.linked.push({ state: "linked", course, link, project: link.project_id ? (projectsById.get(link.project_id) ?? null) : null });
    } else mapping.ignored.push({ state: "ignored", course, link });
  }
  mapping.missing = links.filter((link) => !seen.has(link.canvas_course_id));
  return mapping;
}
