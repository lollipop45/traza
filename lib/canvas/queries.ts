import "server-only";
import { readCanvasConfig } from "./env";
import { readCanvasOverview, readCourseAssignments, type CanvasOverview } from "./read";
import type { AssignmentsRead } from "./sync";

// Server-only entry point to Canvas. `server-only` makes any accidental import from a Client
// Component a build error, so the token-reading code can never reach the browser.

/** Identity and active courses of the configured Canvas account. Never throws. */
export async function getCanvasOverview(): Promise<CanvasOverview> {
  return readCanvasOverview(readCanvasConfig());
}

/** Assignments of one course the caller has already verified against getCanvasOverview(). Never throws. */
export async function getCanvasCourseAssignments(courseId: string): Promise<AssignmentsRead> {
  return readCourseAssignments(readCanvasConfig(), courseId);
}
