import type { GoogleSyncOutcome, LeasedGoogleSyncResult } from "./auto-sync";

// The browser ↔ server contract of the automatic Google Calendar sync trigger. Pure (shared by the
// route handler and the client trigger; tested without Next.js).
//
// The browser only ever says "check whether my Google sync is due": no body is read, so no user,
// calendar, event or project id, and no token, can be supplied. The answer is an enum and a boolean.

export const GOOGLE_AUTO_SYNC_PATH = "/api/integrations/google/auto-sync";

/** Custom header required by the same-origin check (lib/security/same-origin.ts). */
export const GOOGLE_AUTO_SYNC_HEADER = "x-traza-google-sync";

/** Shared across tabs (localStorage) so several open tabs do not each ask. Holds a time only. */
export const GOOGLE_AUTO_SYNC_STORAGE_KEY = "traza.google-auto-sync.last-request";

/** What the browser receives: never counts, ids, names, e-mails or error details. */
export type GoogleAutoSyncResponse = { outcome: GoogleSyncOutcome; changed: boolean };

export function googleAutoSyncResponse(result: LeasedGoogleSyncResult): GoogleAutoSyncResponse {
  // Only Google → TRAZA changes alter what TRAZA shows; mirrors written to Google do not.
  return { outcome: result.outcome, changed: result.imported > 0 };
}
