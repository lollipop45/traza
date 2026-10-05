import { createCanvasClient, type CanvasClientOptions } from "./client";
import type { CanvasConfigResult } from "./env";
import { parseCourses, parseProfile, selectActiveCourses } from "./parse";
import { CanvasError, type CanvasCourse, type CanvasErrorKind, type CanvasProfile } from "./types";

// Read-only Canvas overview, independent of Next.js so it can be tested with a mock server.
// The server-only entry point that reads the real environment is lib/canvas/queries.ts.

export type CanvasOverview =
  | { state: "not-configured"; problem: "missing" | "invalid-base-url" | "invalid-token" }
  | { state: "error"; kind: Exclude<CanvasErrorKind, "not-configured">; status: number | null }
  | {
      state: "connected";
      profile: CanvasProfile;
      /** Available courses with an active enrollment, by name. */
      courses: CanvasCourse[];
      /** Listed by Canvas but hidden until their access dates. */
      restrictedCount: number;
      /** Entries Canvas returned that TRAZA could not read (shape mismatch). */
      skippedCount: number;
      /** More pages than the safety limit: the list may be incomplete. */
      truncated: boolean;
    };

/** GET /api/v1/courses parameters: active enrollments only, with the term. */
export const ACTIVE_COURSE_PARAMS = {
  enrollment_state: "active",
  "include[]": ["term"],
} as const;

/** Never throws: every failure becomes a categorised state with no sensitive details. */
export async function readCanvasOverview(configResult: CanvasConfigResult, options: CanvasClientOptions = {}): Promise<CanvasOverview> {
  if (!configResult.ok) return { state: "not-configured", problem: configResult.problem };
  const client = createCanvasClient(configResult.config, options);

  try {
    // Identity first: it is the cheapest check that the token is valid.
    const profile = parseProfile(await client.getJson("users/self"));
    if (!profile) return { state: "error", kind: "invalid-response", status: null };

    const { items, truncated } = await client.getAllPages("courses", ACTIVE_COURSE_PARAMS);
    const { courses, skipped } = parseCourses(items);
    const { active, restricted } = selectActiveCourses(courses);
    return { state: "connected", profile, courses: active, restrictedCount: restricted.length, skippedCount: skipped, truncated };
  } catch (error) {
    if (error instanceof CanvasError && error.kind !== "not-configured") {
      return { state: "error", kind: error.kind, status: error.status };
    }
    return { state: "error", kind: "invalid-response", status: null };
  }
}
