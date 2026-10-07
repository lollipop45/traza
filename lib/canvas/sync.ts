import type { ISODate } from "@/lib/calendar/types";
import { assignmentExternalId, assignmentRelevance, toTaskWrite, type CanvasTaskWrite } from "./assignments";
import { classifyAssignment, type AssignmentClass } from "./classify";
import type { CanvasCourseLink } from "./mapping";
import type { CanvasOverview } from "./read";
import { canvasFailureCode, type CanvasFailure, type SyncErrorCode } from "./sync-policy";
import type { CanvasAssignment } from "./types";

// THE Canvas assignment reconciliation engine, shared by the manual sync ("Vista previa" /
// "Sincronizar Campus") and the automatic one (lib/canvas/auto-sync.ts wraps it with the per-user
// lease and cooldown). Independent of Next.js and Supabase so it can be tested with a mocked Canvas
// and store; lib/canvas/sync-deps.ts wires the real dependencies. There is no second implementation
// of these rules anywhere.
//
// Authenticity: a stored link is never enough. Each run reads the user's current Canvas courses on
// the server and only syncs links whose course id is in that live response. Links Canvas no longer
// returns are reported and kept; nothing is ever deleted here.
//
// Relevance, per assignment, in this order:
//   1. ignored by the user (canvas_assignment_preferences) → skipped, always;
//   2. unpublished or outside the date window (assignmentRelevance) → omitted, counted only;
//   3. unreadable for a task (toTaskWrite) → malformed, counted only;
//   4. classifyAssignment: actionable → imported; ignored-by-rule → omitted and listed;
//      needs-review → listed under "Revisar", imported only once the user chose "Importar".
// A task that already exists but would no longer be imported is listed as "imported, review": it
// is never deleted silently; the user's "Ignorar en TRAZA" removes it. Likewise, an assignment
// missing from one Canvas response never deletes its task: absence alone is not evidence.

export type SyncMode = "preview" | "sync";

export type AssignmentsRead =
  | { ok: true; assignments: CanvasAssignment[]; malformed: number; truncated: boolean }
  | { ok: false; failure?: CanvasFailure };

export type UpsertOutcome = { assignment_id: string; outcome: string };

/** A row of public.canvas_assignment_preferences, as the sync needs it. */
export type AssignmentPreference = {
  canvas_course_id: string;
  canvas_assignment_id: string;
  state: string;
};

export type SyncDeps = {
  loadOverview: () => Promise<CanvasOverview>;
  loadLinks: () => Promise<{ ok: true; links: CanvasCourseLink[] } | { ok: false }>;
  loadProjectNames: () => Promise<Map<string, string>>;
  loadAssignments: (courseId: string) => Promise<AssignmentsRead>;
  /** The user's per-assignment decisions. Null on error: nothing is written then. */
  loadPreferences: () => Promise<AssignmentPreference[] | null>;
  /** External ids of the user's existing Canvas tasks (read-only). */
  loadExistingExternalIds: () => Promise<Set<string> | null>;
  /** Sync only: one call of sync_canvas_course_tasks. Null on any database error. */
  upsertCourseTasks: (courseId: string, writes: CanvasTaskWrite[]) => Promise<UpsertOutcome[] | null>;
  /** Calendar day in Atlantic/Canary, for the relevance window. */
  today: ISODate;
};

export type SyncItemGroup =
  /** Will be (or was) imported: actionable, or a review item the user included. */
  | "import"
  /** Needs the user's decision; not imported. */
  | "review"
  /** Omitted by an automatic rule (gradebook, attendance). */
  | "auto-ignored"
  /** Already a TRAZA task, but the classifier would no longer import it. Left untouched. */
  | "imported-review";

/**
 * One assignment the user may want to see or act on. The Canvas ids are carried only so that
 * "Importar" / "Ignorar" can name the assignment back to the server, which re-verifies it; they are
 * never displayed.
 */
export type SyncItem = {
  courseId: string;
  assignmentId: string;
  title: string;
  courseName: string;
  projectName: string | null;
  dueDate: ISODate | null;
  group: SyncItemGroup;
  classification: AssignmentClass;
  /** A TRAZA task already exists for it. */
  imported: boolean;
  /** The user chose "Importar" for this review item. */
  included: boolean;
};

export type CourseSyncStatus = "synced" | "previewed" | "not-in-canvas" | "failed";

export type CourseSyncReport = {
  courseName: string;
  projectName: string | null;
  status: CourseSyncStatus;
  /** Assignments Canvas returned (readable or not). */
  received: number;
  /** What sync writes: actionable + included review items. */
  toImport: number;
  /** Of those, Canvas proves were handed in (imported/marked as done). */
  submitted: number;
  review: number;
  autoIgnored: number;
  userIgnored: number;
  importedReview: number;
  /** Unpublished or outside the date window. */
  old: number;
  malformed: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Preview: of toImport, no TRAZA task yet / already imported. */
  toCreate: number;
  existing: number;
  truncated: boolean;
};

export type CanvasSyncSummary = {
  mode: SyncMode;
  coursesChecked: number;
  coursesSynced: number;
  /** Linked, but not among the live Canvas courses: skipped, link kept. */
  coursesSkipped: number;
  coursesFailed: number;
  assignmentsReceived: number;
  toImport: number;
  review: number;
  userIgnored: number;
  importedReview: number;
  /** Automatically omitted: rule-ignored + old/unpublished + malformed. */
  omitted: number;
  created: number;
  updated: number;
  unchanged: number;
  toCreate: number;
  existing: number;
  errors: number;
  /** Safe code of the first failed course (null when none failed). */
  errorCode: SyncErrorCode | null;
  courses: CourseSyncReport[];
  items: SyncItem[];
};

export type CanvasSyncResult = { ok: true; summary: CanvasSyncSummary } | { ok: false; error: string; code: SyncErrorCode };

/** Rows per sync_canvas_course_tasks call (the function accepts up to 500). */
export const UPSERT_BATCH_SIZE = 200;

export function canvasUnavailableMessage(overview: Exclude<CanvasOverview, { state: "connected" }>): string {
  if (overview.state === "not-configured") return "Canvas no está configurado.";
  if (overview.kind === "unauthorized") return "No se ha podido autenticar con Campus Virtual.";
  return "Campus Virtual no está disponible en este momento.";
}

export function preferenceKey(courseId: string, assignmentId: string): string {
  return `${courseId}:${assignmentId}`;
}

function emptyReport(courseName: string, projectName: string | null, status: CourseSyncStatus): CourseSyncReport {
  return {
    courseName,
    projectName,
    status,
    received: 0,
    toImport: 0,
    submitted: 0,
    review: 0,
    autoIgnored: 0,
    userIgnored: 0,
    importedReview: 0,
    old: 0,
    malformed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    toCreate: 0,
    existing: 0,
    truncated: false,
  };
}

type CourseContext = { courseId: string; courseName: string; projectName: string | null };

/** Classifies a course's assignments: task writes, listed items and counted skips. */
export function planCourse(
  assignments: CanvasAssignment[],
  context: CourseContext,
  preferences: ReadonlyMap<string, string>,
  existing: ReadonlySet<string>,
  today: ISODate,
) {
  const writes: CanvasTaskWrite[] = [];
  const items: SyncItem[] = [];
  const counts = { userIgnored: 0, old: 0, malformed: 0 };
  const seen = new Set<string>();

  for (const assignment of assignments) {
    // A repeated id in one response (pagination overlap) is considered once.
    if (seen.has(assignment.id)) continue;
    seen.add(assignment.id);

    const preference = preferences.get(preferenceKey(context.courseId, assignment.id));
    if (preference === "ignored") {
      counts.userIgnored += 1;
      continue;
    }
    if (!assignmentRelevance(assignment, today).relevant) {
      counts.old += 1;
      continue;
    }
    const write = toTaskWrite(assignment);
    if (!write) {
      counts.malformed += 1;
      continue;
    }

    const classification = classifyAssignment(assignment);
    const included = classification.kind === "needs-review" && preference === "included";
    const imported = existing.has(assignmentExternalId(context.courseId, assignment.id));
    const group: SyncItemGroup =
      classification.kind === "actionable" || included
        ? "import"
        : imported
          ? "imported-review"
          : classification.kind === "needs-review"
            ? "review"
            : "auto-ignored";

    if (group === "import") writes.push(write);
    items.push({ ...context, assignmentId: assignment.id, title: write.title, dueDate: write.due_date, group, classification, imported, included });
  }
  return { writes, items, ...counts };
}

export async function runCanvasSync(deps: SyncDeps, mode: SyncMode): Promise<CanvasSyncResult> {
  const overview = await deps.loadOverview();
  if (overview.state !== "connected") {
    const code = overview.state === "not-configured" ? "not_configured" : canvasFailureCode(overview);
    return { ok: false, error: canvasUnavailableMessage(overview), code };
  }

  const linkResult = await deps.loadLinks();
  if (!linkResult.ok) return { ok: false, error: "No se han podido cargar tus vínculos con Campus.", code: "database" };

  // Without the user's decisions an ignored assignment could be recreated: stop before any write.
  const preferenceRows = await deps.loadPreferences();
  if (!preferenceRows) return { ok: false, error: "No se han podido cargar tus decisiones sobre entregas.", code: "database" };
  const preferences = new Map(preferenceRows.map((row) => [preferenceKey(row.canvas_course_id, row.canvas_assignment_id), row.state]));

  const existing = await deps.loadExistingExternalIds();
  if (!existing) return { ok: false, error: "No se han podido leer tus tareas.", code: "database" };

  // Only links the user made (state = linked); ignored courses and unmapped ones (no row) never sync.
  const linked = linkResult.links.filter((link) => link.state === "linked" && link.project_id);
  const liveCourses = new Map(overview.courses.map((course) => [course.id, course]));
  const projectNames = await deps.loadProjectNames();

  const reports: CourseSyncReport[] = [];
  const items: SyncItem[] = [];
  let errors = 0;
  let errorCode: SyncErrorCode | null = null;

  // Sequential: a handful of courses, and gentle on the Canvas API.
  for (const link of linked) {
    const course = liveCourses.get(link.canvas_course_id);
    const projectName = (link.project_id && projectNames.get(link.project_id)) || null;
    const courseName = course?.name ?? link.canvas_course_name ?? "Curso de Campus";

    if (!course) {
      reports.push(emptyReport(courseName, projectName, "not-in-canvas"));
      continue;
    }

    const read = await deps.loadAssignments(course.id);
    if (!read.ok) {
      errors += 1;
      errorCode ??= canvasFailureCode(read.failure);
      reports.push(emptyReport(courseName, projectName, "failed"));
      continue;
    }

    const plan = planCourse(read.assignments, { courseId: course.id, courseName, projectName }, preferences, existing, deps.today);
    const count = (group: SyncItemGroup) => plan.items.filter((item) => item.group === group).length;
    const report: CourseSyncReport = {
      ...emptyReport(courseName, projectName, mode === "preview" ? "previewed" : "synced"),
      received: read.assignments.length + read.malformed,
      toImport: plan.writes.length,
      submitted: plan.writes.filter((write) => write.submitted).length,
      review: count("review"),
      autoIgnored: count("auto-ignored"),
      importedReview: count("imported-review"),
      userIgnored: plan.userIgnored,
      old: plan.old,
      malformed: read.malformed + plan.malformed,
      toCreate: plan.items.filter((item) => item.group === "import" && !item.imported).length,
      existing: plan.items.filter((item) => item.group === "import" && item.imported).length,
      truncated: read.truncated,
    };
    items.push(...plan.items);

    if (mode === "sync") {
      for (let start = 0; start < plan.writes.length; start += UPSERT_BATCH_SIZE) {
        const outcomes = await deps.upsertCourseTasks(course.id, plan.writes.slice(start, start + UPSERT_BATCH_SIZE));
        if (!outcomes) {
          // Earlier batches are already committed and stay counted; the course is reported as failed.
          errors += 1;
          errorCode ??= "database";
          report.status = "failed";
          break;
        }
        for (const { outcome } of outcomes) {
          if (outcome === "created") report.created += 1;
          else if (outcome === "updated") report.updated += 1;
          // Ignored meanwhile (the database refuses to recreate it).
          else if (outcome === "ignored") report.userIgnored += 1;
          else report.unchanged += 1;
        }
      }
    }
    reports.push(report);
  }

  const sum = (key: keyof CourseSyncReport) => reports.reduce((total, report) => total + (report[key] as number), 0);
  return {
    ok: true,
    summary: {
      mode,
      coursesChecked: linked.length,
      coursesSynced: reports.filter((report) => report.status === "synced" || report.status === "previewed").length,
      coursesSkipped: reports.filter((report) => report.status === "not-in-canvas").length,
      coursesFailed: reports.filter((report) => report.status === "failed").length,
      assignmentsReceived: sum("received"),
      toImport: sum("toImport"),
      review: sum("review"),
      userIgnored: sum("userIgnored"),
      importedReview: sum("importedReview"),
      omitted: sum("autoIgnored") + sum("old") + sum("malformed"),
      created: sum("created"),
      updated: sum("updated"),
      unchanged: sum("unchanged"),
      toCreate: sum("toCreate"),
      existing: sum("existing"),
      errors,
      errorCode,
      courses: reports,
      items,
    },
  };
}
