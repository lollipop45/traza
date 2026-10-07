import "server-only";
import type { CanvasClientOptions } from "./client";
import { readCanvasConfig } from "./env";
import { readCanvasOverview, readCourseAssignments, type CanvasOverview } from "./read";
import type { AssignmentsRead } from "./sync";

// Server-only entry point to Canvas. `server-only` makes any accidental import from a Client
// Component a build error, so the token-reading code can never reach the browser.

/** Only the run deadline can be chosen by callers; the fetch and the token stay internal. */
export type CanvasReadOptions = Pick<CanvasClientOptions, "deadline">;

/** Identity and active courses of the configured Canvas account. Never throws. */
export async function getCanvasOverview(options: CanvasReadOptions = {}): Promise<CanvasOverview> {
  return readCanvasOverview(readCanvasConfig(), { deadline: options.deadline });
}

/** Assignments of one course the caller has already verified against getCanvasOverview(). Never throws. */
export async function getCanvasCourseAssignments(courseId: string, options: CanvasReadOptions = {}): Promise<AssignmentsRead> {
  return readCourseAssignments(readCanvasConfig(), courseId, { deadline: options.deadline });
}

/** Whether Canvas is configured at all (no network): the automatic trigger is only rendered then. */
export function isCanvasConfigured(): boolean {
  return readCanvasConfig().ok;
}
