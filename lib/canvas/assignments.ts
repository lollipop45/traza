import { addDays, isoDateInZone } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/tasks/types";
import type { CanvasClient } from "./client";
import { isCanvasCourseId } from "./mapping";
import type { CanvasAssignment, CanvasSubmission } from "./types";

// Canvas assignments → TRAZA task writes. Pure apart from fetchCourseAssignments, which takes an
// already-configured client, so all of it is testable without a network or a token.

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canvasId(value: unknown): string | null {
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** An instant with an explicit offset ("2026-10-12T22:59:00Z"), so no zone is ever guessed. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export function isCanvasInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/** Missing or null → null. Present but unreadable → "invalid" (the assignment is then skipped). */
function instant(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && isCanvasInstant(value.trim()) ? value.trim() : "invalid";
}

function parseSubmission(value: unknown): CanvasSubmission | null {
  if (!isRecord(value)) return null;
  const submittedAt = instant(value.submitted_at);
  return {
    workflowState: text(value.workflow_state),
    submittedAt: submittedAt === "invalid" ? null : submittedAt,
    excused: value.excused === true,
  };
}

/**
 * One assignment from GET /courses/:id/assignments, or null when unreadable: no id, no name, a
 * due date that is not a real instant, or a course_id that contradicts the course it was read from.
 */
export function parseAssignment(value: unknown, courseId: string): CanvasAssignment | null {
  if (!isRecord(value)) return null;
  const id = canvasId(value.id);
  const name = text(value.name);
  if (!id || !name) return null;
  if (value.course_id !== undefined && canvasId(value.course_id) !== courseId) return null;

  const dueAt = instant(value.due_at);
  if (dueAt === "invalid") return null;
  const optional = (raw: unknown) => {
    const parsed = instant(raw);
    return parsed === "invalid" ? null : parsed;
  };

  return {
    id,
    courseId,
    name,
    dueAt,
    unlockAt: optional(value.unlock_at),
    lockAt: optional(value.lock_at),
    published: typeof value.published === "boolean" ? value.published : null,
    workflowState: text(value.workflow_state),
    createdAt: optional(value.created_at),
    updatedAt: optional(value.updated_at),
    submission: parseSubmission(value.submission),
    submissionTypes: parseSubmissionTypes(value.submission_types),
    gradingType: text(value.grading_type)?.toLowerCase() ?? null,
    pointsPossible: typeof value.points_possible === "number" && Number.isFinite(value.points_possible) ? value.points_possible : null,
    omitFromFinalGrade: typeof value.omit_from_final_grade === "boolean" ? value.omit_from_final_grade : null,
  };
}

/** Lowercased, trimmed, deduplicated strings; non-strings dropped. Not an array → null (unknown). */
export function parseSubmissionTypes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const types = value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return [...new Set(types)];
}

export function parseAssignments(values: unknown[], courseId: string): { assignments: CanvasAssignment[]; malformed: number } {
  const assignments: CanvasAssignment[] = [];
  let malformed = 0;
  for (const value of values) {
    const assignment = parseAssignment(value, courseId);
    if (assignment) assignments.push(assignment);
    else malformed += 1;
  }
  return { assignments, malformed };
}

/**
 * GET /api/v1/courses/:course_id/assignments, every page. `include[]=submission` adds the
 * requesting user's own submission (used only for the conservative completion rule).
 */
export const ASSIGNMENT_PARAMS = {
  "include[]": ["submission"],
  order_by: "due_at",
} as const;

export async function fetchCourseAssignments(
  client: CanvasClient,
  courseId: string,
): Promise<{ assignments: CanvasAssignment[]; malformed: number; truncated: boolean }> {
  // The id is interpolated into the path: only digits are ever accepted.
  if (!isCanvasCourseId(courseId)) throw new TypeError("Invalid Canvas course id");
  const { items, truncated } = await client.getAllPages(`courses/${courseId}/assignments`, ASSIGNMENT_PARAMS);
  return { ...parseAssignments(items, courseId), truncated };
}

/** Calendar day of a Canvas due instant in Atlantic/Canary (the task's due_date). */
export function canvasDueDate(dueAt: string): ISODate {
  return isoDateInZone(dueAt);
}

/** `course:<courseId>:assignment:<assignmentId>`; the database builds the same value itself. */
export function assignmentExternalId(courseId: string, assignmentId: string): string {
  return `course:${courseId}:assignment:${assignmentId}`;
}

const SUBMITTED_STATES = new Set(["submitted", "pending_review", "graded"]);

/**
 * True only when Canvas clearly reports that this student handed it in: a submission timestamp AND
 * a submitted/graded state. "graded" without submitted_at (e.g. a zero for missing work), excused,
 * "unsubmitted" or no submission at all are not proof.
 */
export function isSubmitted(submission: CanvasSubmission | null): boolean {
  return Boolean(submission && submission.submittedAt && submission.workflowState && SUBMITTED_STATES.has(submission.workflowState));
}

// ---------------------------------------------------------------------------
// Relevance: what is actionable for the student now.
// ---------------------------------------------------------------------------

/** Dated assignments due up to this many days ago are still imported (recently missed / late). */
export const RECENT_PAST_DAYS = 30;
/** Undated assignments are imported only if Canvas created them within this many days. */
export const UNDATED_MAX_AGE_DAYS = 180;

export type SkipReason = "unpublished" | "past" | "stale-undated";
export type Relevance = { relevant: true } | { relevant: false; reason: SkipReason };

/**
 * The exact filter (today = calendar day in Atlantic/Canary):
 *   1. unpublished (published = false, or workflow_state unpublished/deleted) → never;
 *   2. dated → only if due on or after today − 30 days (future dates are always kept);
 *   3. undated → only if created within the last 180 days AND not locked before today (an
 *      undated assignment without created_at is skipped: its age is unknown).
 * No semester names, no course dates: it works the same for perpetual "active" courses.
 */
export function assignmentRelevance(assignment: CanvasAssignment, today: ISODate): Relevance {
  if (assignment.published === false || assignment.workflowState === "unpublished" || assignment.workflowState === "deleted") {
    return { relevant: false, reason: "unpublished" };
  }
  if (assignment.dueAt) {
    return canvasDueDate(assignment.dueAt) >= addDays(today, -RECENT_PAST_DAYS) ? { relevant: true } : { relevant: false, reason: "past" };
  }
  const recent = assignment.createdAt !== null && isoDateInZone(assignment.createdAt) >= addDays(today, -UNDATED_MAX_AGE_DAYS);
  const open = assignment.lockAt === null || isoDateInZone(assignment.lockAt) >= today;
  return recent && open ? { relevant: true } : { relevant: false, reason: "stale-undated" };
}

/** Exactly what sync_canvas_course_tasks accepts per element (see its migration). */
export type CanvasTaskWrite = {
  assignment_id: string;
  title: string;
  due_date: ISODate | null;
  submitted: boolean;
};

/** Whitespace collapsed, clipped to the task title limit (no HTML is ever read: only `name`). */
export function assignmentTitle(name: string): string {
  return [...name.replace(/\s+/g, " ").trim()].slice(0, TASK_TITLE_MAX_LENGTH).join("");
}

/** Null when the due date falls outside what tasks accept (2000–2100): skipped as malformed. */
export function toTaskWrite(assignment: CanvasAssignment): CanvasTaskWrite | null {
  const dueDate = assignment.dueAt ? canvasDueDate(assignment.dueAt) : null;
  if (dueDate && (dueDate < "2000-01-01" || dueDate > "2100-12-31")) return null;
  const title = assignmentTitle(assignment.name);
  if (!title) return null;
  return { assignment_id: assignment.id, title, due_date: dueDate, submitted: isSubmitted(assignment.submission) };
}
