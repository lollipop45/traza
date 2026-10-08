import { isSameOriginRequest as isSameOriginWithHeader } from "@/lib/security/same-origin";
import type { LeasedSyncResult, SyncOutcome } from "./auto-sync";

// The browser ↔ server contract of the automatic Canvas sync trigger. Pure (shared by the route
// handler and the client trigger; tested without Next.js).
//
// The browser only ever says "check whether my Canvas sync is due": no body is read, so no user,
// course, project or assignment id can be supplied. The answer is an enum and a boolean.

export const AUTO_SYNC_PATH = "/api/integrations/canvas/auto-sync";

/**
 * A custom header: a cross-site page cannot send it without a CORS preflight, which this endpoint
 * never grants. One of three independent same-origin checks (with Origin and Sec-Fetch-Site).
 */
export const AUTO_SYNC_HEADER = "x-traza-auto-sync";

/** Same-origin POST check (CSRF), shared with the Google endpoint: lib/security/same-origin.ts. */
export function isSameOriginRequest(headers: Headers): boolean {
  return isSameOriginWithHeader(headers, AUTO_SYNC_HEADER);
}

/** What the browser receives: never counts, ids, names or error details. */
export type AutoSyncResponse = { outcome: SyncOutcome; changed: boolean };

export function autoSyncResponse(result: LeasedSyncResult): AutoSyncResponse {
  return { outcome: result.outcome, changed: result.imported + result.updated > 0 };
}
