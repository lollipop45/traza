import type { FetchLike, GoogleCalendar, GoogleErrorKind } from "./types";

// Google Calendar API v3, read-only calendar discovery. The access token travels only in the
// Authorization header to www.googleapis.com; redirects are refused; errors are categories only.

const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const REQUEST_TIMEOUT_MS = 10_000;
/** Upper bound on followed pages (250 calendars each). */
const MAX_PAGES = 10;

export type CalendarListResult = { ok: true; calendars: GoogleCalendar[] } | { ok: false; kind: GoogleErrorKind };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One calendarList entry, or null when unreadable (no id). */
export function parseCalendar(value: unknown): GoogleCalendar | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 1024 ? entry.id : null;
  if (!id) return null;
  if (entry.deleted === true) return null;
  const name = text(entry.summaryOverride) ?? text(entry.summary) ?? id;
  return { id, name: [...name].slice(0, 300).join(""), primary: entry.primary === true, accessRole: text(entry.accessRole) ?? "reader" };
}

/**
 * Calendars TRAZA may write to later: with the calendar.events.owned scope, only calendars the
 * user owns. Calendars shared with them (writer/reader) are listed by Google but not offered.
 */
export function isWritableCalendar(calendar: Pick<GoogleCalendar, "accessRole">): boolean {
  return calendar.accessRole === "owner";
}

/** Primary first, then by name. */
export function sortCalendars(calendars: GoogleCalendar[]): GoogleCalendar[] {
  return [...calendars].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id));
}

/** The connected account's address: Google uses it as the primary calendar's id. */
export function accountEmailFrom(calendars: GoogleCalendar[]): string | null {
  const primary = calendars.find((calendar) => calendar.primary);
  return primary && /^[^\s@]{1,200}@[^\s@]{1,200}$/.test(primary.id) ? primary.id : null;
}

function classify(status: number): GoogleErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429 || status >= 500) return "unavailable";
  return "invalid-response";
}

/** Every calendar in the user's list (paginated). Never throws. */
export async function listCalendars(accessToken: string, fetchFn: FetchLike): Promise<CalendarListResult> {
  const calendars: GoogleCalendar[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(CALENDAR_LIST_URL);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("fields", "items(id,summary,summaryOverride,primary,accessRole,deleted),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, kind: "unavailable" };
    }
    if (!response.ok) return { ok: false, kind: classify(response.status) };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, kind: "invalid-response" };
    }
    if (typeof body !== "object" || body === null) return { ok: false, kind: "invalid-response" };
    const { items, nextPageToken } = body as Record<string, unknown>;
    if (items !== undefined && !Array.isArray(items)) return { ok: false, kind: "invalid-response" };
    for (const item of items ?? []) {
      const calendar = parseCalendar(item);
      if (calendar) calendars.push(calendar);
    }
    pageToken = typeof nextPageToken === "string" && nextPageToken ? nextPageToken : null;
    if (!pageToken) break;
  }
  return { ok: true, calendars: sortCalendars(calendars) };
}
