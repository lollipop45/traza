// Only the subset of Google data TRAZA uses. Google responses are untrusted input: they are
// projected field by field, never cast. Nothing here ever carries a token.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A calendar from the user's calendar list. */
export type GoogleCalendar = {
  /** Google calendar id (the primary one is the account's address). Not shown in the UI. */
  id: string;
  /** summaryOverride (the user's own name for it) or summary. */
  name: string;
  primary: boolean;
  /** "owner", "writer", "reader" or "freeBusyReader". */
  accessRole: string;
};

/** Why a Google call failed. Never carries response bodies, URLs or credentials. */
export type GoogleErrorKind =
  /** The refresh token was revoked or expired (invalid_grant): reconnect. */
  | "revoked"
  /** 401 after a refresh, or 403 (scope removed): the authorization no longer works. */
  | "unauthorized"
  /** Network failure, timeout, 429 or 5xx. */
  | "unavailable"
  /** Unexpected status or a shape TRAZA cannot read. */
  | "invalid-response";

/** What the Calendar page shows about the connection. Metadata only. */
export type GoogleConnectionStatus =
  | { state: "not-configured" }
  | { state: "disconnected" }
  | { state: "error" }
  | { state: "connected" | "revoked"; accountEmail: string | null; calendarName: string | null };
