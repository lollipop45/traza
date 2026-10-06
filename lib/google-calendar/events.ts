import { APP_TIME_ZONE } from "@/lib/calendar/dates";
import type { FetchLike, GoogleErrorKind } from "./types";

// Google Calendar API v3, events of ONE calendar (the user's selected, owned calendar). The access
// token travels only in the Authorization header to www.googleapis.com; redirects are refused;
// failures are categories only (never response bodies, URLs or tokens). Google responses are
// untrusted input: projected field by field, never cast.

const API = "https://www.googleapis.com/calendar/v3/calendars";
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 2500;
/** Upper bound on followed pages; beyond it the listing is reported as incomplete. */
const MAX_PAGES = 10;

const LIST_FIELDS = "items(id,status,summary,description,location,start,end,transparency,recurringEventId,extendedProperties/private),nextPageToken";

/** A start or end: a plain date (all-day, end exclusive) or an instant. */
export type GoogleTime = { date: string } | { dateTime: string; timeZone: string | null };

export type GoogleEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string | null;
  description: string | null;
  location: string | null;
  start: GoogleTime | null;
  end: GoogleTime | null;
  /** "opaque" (busy, Google's default) or "transparent" (free). */
  transparency: "opaque" | "transparent";
  /** Present on an occurrence of a recurring event (listed with singleEvents=true). */
  recurringEventId: string | null;
  /** extendedProperties.private: integration metadata, never shown to the user. */
  privateProperties: Record<string, string>;
};

/** The body TRAZA writes for one of its mirrors. */
export type GoogleEventBody = {
  summary: string;
  description: string;
  location: string | null;
  start: GoogleTime;
  end: GoogleTime;
  transparency: "opaque" | "transparent";
  status: "confirmed";
  extendedProperties: { private: Record<string, string> };
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTime(value: unknown): GoogleTime | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const time = value as Record<string, unknown>;
  if (typeof time.date === "string") return { date: time.date };
  if (typeof time.dateTime === "string") return { dateTime: time.dateTime, timeZone: text(time.timeZone) };
  return null;
}

/** One listed event, or null when unusable (no id). Field shapes are checked later, by use. */
export function parseGoogleEvent(value: unknown): GoogleEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 1024) return null;
  const status = event.status === "cancelled" || event.status === "tentative" ? event.status : "confirmed";
  const extended = event.extendedProperties;
  const rawPrivate =
    typeof extended === "object" && extended !== null && !Array.isArray(extended) ? (extended as Record<string, unknown>).private : null;
  const privateProperties: Record<string, string> = {};
  if (typeof rawPrivate === "object" && rawPrivate !== null && !Array.isArray(rawPrivate)) {
    for (const [key, propertyValue] of Object.entries(rawPrivate)) if (typeof propertyValue === "string") privateProperties[key] = propertyValue;
  }
  return {
    id: event.id,
    status,
    summary: text(event.summary),
    description: text(event.description),
    location: text(event.location),
    start: parseTime(event.start),
    end: parseTime(event.end),
    transparency: event.transparency === "transparent" ? "transparent" : "opaque",
    recurringEventId: text(event.recurringEventId),
    privateProperties,
  };
}

function classify(status: number): GoogleErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429 || status >= 500) return "unavailable";
  return "invalid-response";
}

async function request(fetchFn: FetchLike, url: string, accessToken: string, init: { method: string; body?: unknown }): Promise<Response | null> {
  try {
    return await fetchFn(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Network failure or timeout; the error itself is discarded (it may contain request details).
    return null;
  }
}

const eventsUrl = (calendarId: string) => `${API}/${encodeURIComponent(calendarId)}/events`;
const eventUrl = (calendarId: string, eventId: string) => `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;

export type ListEventsResult =
  | { ok: true; events: GoogleEvent[]; unreadable: number }
  | { ok: false; kind: GoogleErrorKind | "too-many" };

/**
 * Every event of the calendar between two instants, recurring events expanded into their
 * occurrences (singleEvents=true), deleted ones included (showDeleted=true, status "cancelled"), so
 * a vanished mirror can be told apart from an unlisted one. Paginated. Never throws.
 */
export async function listEvents(
  accessToken: string,
  calendarId: string,
  range: { timeMin: string; timeMax: string },
  fetchFn: FetchLike,
): Promise<ListEventsResult> {
  const events: GoogleEvent[] = [];
  let unreadable = 0;
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(eventsUrl(calendarId));
    url.searchParams.set("timeMin", range.timeMin);
    url.searchParams.set("timeMax", range.timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    url.searchParams.set("timeZone", APP_TIME_ZONE);
    url.searchParams.set("fields", LIST_FIELDS);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await request(fetchFn, url.toString(), accessToken, { method: "GET" });
    if (!response) return { ok: false, kind: "unavailable" };
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
      const event = parseGoogleEvent(item);
      if (event) events.push(event);
      else unreadable++;
    }
    pageToken = typeof nextPageToken === "string" && nextPageToken ? nextPageToken : null;
    if (!pageToken) return { ok: true, events, unreadable };
  }
  // Too many events to read safely in one manual sync: nothing is planned from a partial list.
  return { ok: false, kind: "too-many" };
}

export type WriteResult = { ok: true } | { ok: false; kind: GoogleErrorKind | "conflict" | "not-found" };

function writeFailure(status: number): WriteResult {
  if (status === 409) return { ok: false, kind: "conflict" };
  if (status === 404 || status === 410) return { ok: false, kind: "not-found" };
  return { ok: false, kind: classify(status) };
}

/** events.insert with TRAZA's own id. 409 = that id already exists (created before). */
export async function insertEvent(accessToken: string, calendarId: string, eventId: string, body: GoogleEventBody, fetchFn: FetchLike): Promise<WriteResult> {
  const url = new URL(eventsUrl(calendarId));
  url.searchParams.set("sendUpdates", "none");
  const response = await request(fetchFn, url.toString(), accessToken, { method: "POST", body: { id: eventId, ...body } });
  if (!response) return { ok: false, kind: "unavailable" };
  return response.ok ? { ok: true } : writeFailure(response.status);
}

/**
 * events.update (full replacement of the fields TRAZA writes). Setting status "confirmed" also
 * restores a mirror that was deleted in Google. 404/410 = gone for good.
 */
export async function updateEvent(accessToken: string, calendarId: string, eventId: string, body: GoogleEventBody, fetchFn: FetchLike): Promise<WriteResult> {
  const url = new URL(eventUrl(calendarId, eventId));
  url.searchParams.set("sendUpdates", "none");
  const response = await request(fetchFn, url.toString(), accessToken, { method: "PUT", body });
  if (!response) return { ok: false, kind: "unavailable" };
  return response.ok ? { ok: true } : writeFailure(response.status);
}

/** events.delete. Already deleted (404/410) counts as done. */
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string, fetchFn: FetchLike): Promise<WriteResult> {
  const url = new URL(eventUrl(calendarId, eventId));
  url.searchParams.set("sendUpdates", "none");
  const response = await request(fetchFn, url.toString(), accessToken, { method: "DELETE" });
  if (!response) return { ok: false, kind: "unavailable" };
  if (response.ok || response.status === 404 || response.status === 410) return { ok: true };
  return writeFailure(response.status);
}
