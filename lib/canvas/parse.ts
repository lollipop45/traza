import type { CanvasCourse, CanvasEnrollment, CanvasProfile, CanvasTerm } from "./types";

// Defensive projection of untrusted Canvas JSON into TRAZA's small types. Every optional field may
// be missing or of an unexpected type on a given Canvas installation; required ones (ids, names)
// make the item unreadable (null) instead of crashing.

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Canvas ids, as strings (string-ids mode) or numbers (if an installation ignores it). */
function canvasId(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

export function parseProfile(value: unknown): CanvasProfile | null {
  if (!isRecord(value)) return null;
  const id = canvasId(value.id);
  const name = text(value.name);
  if (!id || !name) return null;
  const shortName = text(value.short_name);
  return { id, name, shortName: shortName && shortName !== name ? shortName : null };
}

function parseTerm(value: unknown): CanvasTerm | null {
  if (!isRecord(value)) return null;
  const term = { id: canvasId(value.id), name: text(value.name), startAt: text(value.start_at), endAt: text(value.end_at) };
  return term.id || term.name ? term : null;
}

function parseEnrollments(value: unknown): CanvasEnrollment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((enrollment) => ({ type: text(enrollment.type), state: text(enrollment.enrollment_state) }));
}

export function parseCourse(value: unknown): CanvasCourse | null {
  if (!isRecord(value)) return null;
  const id = canvasId(value.id);
  if (!id) return null;
  return {
    id,
    name: text(value.name),
    courseCode: text(value.course_code),
    workflowState: text(value.workflow_state),
    startAt: text(value.start_at),
    endAt: text(value.end_at),
    term: parseTerm(value.term),
    enrollments: parseEnrollments(value.enrollments),
    accessRestricted: value.access_restricted_by_date === true,
  };
}

/** Projects a list response; unreadable entries are dropped and counted, never fatal. */
export function parseCourses(values: unknown[]): { courses: CanvasCourse[]; skipped: number } {
  const courses: CanvasCourse[] = [];
  let skipped = 0;
  for (const value of values) {
    const course = parseCourse(value);
    if (course) courses.push(course);
    else skipped += 1;
  }
  return { courses, skipped };
}

export type CourseSelection = {
  /** Readable, available courses where the user has an active enrollment. */
  active: CanvasCourse[];
  /** Courses Canvas lists but hides until their access dates. */
  restricted: CanvasCourse[];
};

/**
 * The courses relevant now. The API call already asks for active enrollments; this also drops
 * courses Canvas marks unpublished/completed/deleted, and any course whose own enrollment list
 * (when present) has no active enrollment. Sorted by name, then id, for a stable display.
 */
export function selectActiveCourses(courses: CanvasCourse[]): CourseSelection {
  const active: CanvasCourse[] = [];
  const restricted: CanvasCourse[] = [];
  for (const course of courses) {
    if (course.accessRestricted) {
      restricted.push(course);
      continue;
    }
    const available = course.workflowState === null || course.workflowState === "available";
    const enrolled = course.enrollments.length === 0 || course.enrollments.some((e) => e.state === null || e.state === "active");
    if (available && enrolled) active.push(course);
  }
  const byName = (a: CanvasCourse, b: CanvasCourse) =>
    (a.name ?? "").localeCompare(b.name ?? "", "es") || a.id.localeCompare(b.id, "en", { numeric: true });
  return { active: active.sort(byName), restricted: restricted.sort(byName) };
}
