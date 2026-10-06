import { createHash } from "node:crypto";
import { APP_TIME_ZONE, addDays, isValidISODate } from "@/lib/calendar/dates";
import { GOOGLE_EVENT_SOURCE, type CalendarEventRow, type ISODate } from "@/lib/calendar/types";
import type { Tables } from "@/lib/supabase/database.types";
import type { TaskRow } from "@/lib/tasks/types";
import type { GoogleEvent, GoogleEventBody, GoogleTime } from "./events";
import { inWindow, instantOfWallClock, localDateTime, parseGoogleDateTime, wallClockAt, type SyncWindow } from "./time";

// The rules of the manual Google Calendar sync, as pure functions. One planner (planSync) decides
// everything; "Vista previa" shows its plan and "Sincronizar" executes the same plan, so the
// preview predicts the sync exactly. No I/O here.
//
// Ownership is by origin, never "last write wins":
//   TRAZA-origin (calendar events not imported from Google; tasks with a due date): TRAZA owns the
//     content. Google gets a mirror, recognised by private extended properties (never by title).
//     A mirror edited or deleted in Google is restored from TRAZA by the next sync.
//   Google-origin (independent events of the selected calendar): Google owns title, description,
//     location, date and times. TRAZA keeps one calendar_events row per Google event
//     (source = google-calendar, external_id from calendar id + event id). The project stays TRAZA's.

export { GOOGLE_EVENT_SOURCE };

export type MirrorType = "calendar_event" | "task";

/** Private extended properties on every mirror. Machine identity; never in the visible text. */
export const MIRROR_PROPERTIES = { managed: "trazaManaged", type: "trazaType", localId: "trazaLocalId", version: "trazaVersion" } as const;
export const MIRROR_VERSION = "1";

export type LocalEvent = Pick<
  CalendarEventRow,
  "id" | "title" | "description" | "event_date" | "start_time" | "end_time" | "all_day" | "location" | "project_id" | "source" | "external_id"
>;
export const LOCAL_EVENT_COLUMNS = "id, title, description, event_date, start_time, end_time, all_day, location, project_id, source, external_id";

export type LocalTask = Pick<TaskRow, "id" | "title" | "status" | "due_date" | "project_id" | "source">;
export const LOCAL_TASK_COLUMNS = "id, title, status, due_date, project_id, source";

export type ItemLink = Pick<
  Tables<"google_calendar_item_links">,
  "id" | "google_calendar_id" | "google_event_id" | "item_type" | "task_id" | "calendar_event_id" | "content_hash"
>;
export const ITEM_LINK_COLUMNS = "id, google_calendar_id, google_event_id, item_type, task_id, calendar_event_id, content_hash";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The Google id TRAZA gives the mirror of an item in a calendar: deterministic, so creating it twice
 * (a repeated or concurrent sync, a crash between Google and the database) collides at Google
 * (409) instead of producing a duplicate. Hex is valid base32hex, as Google requires.
 */
export function mirrorEventId(type: MirrorType, localId: string, calendarId: string): string {
  return createHash("sha256").update(`traza:mirror:v1:${type}:${localId}:${calendarId}`).digest("hex");
}

/** calendar_events.external_id of a Google-origin event. */
export function importedExternalId(calendarId: string, eventId: string): string {
  return `calendar:${calendarId}:event:${eventId}`;
}

const IMPORTABLE_EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

/** The item a Google event claims to mirror (private properties), or null for independent events. */
export function mirrorClaim(event: Pick<GoogleEvent, "privateProperties">): { type: MirrorType; localId: string } | null {
  const props = event.privateProperties;
  if (props[MIRROR_PROPERTIES.managed] !== "1") return null;
  const type = props[MIRROR_PROPERTIES.type];
  const localId = props[MIRROR_PROPERTIES.localId] ?? "";
  return (type === "task" || type === "calendar_event") && /^[0-9a-f-]{36}$/i.test(localId) ? { type, localId: localId.toLowerCase() } : null;
}

export function isTrazaManaged(event: Pick<GoogleEvent, "privateProperties">): boolean {
  return event.privateProperties[MIRROR_PROPERTIES.managed] === "1";
}

// ---------------------------------------------------------------------------
// TRAZA → Google: mirror content
// ---------------------------------------------------------------------------

function privateProperties(type: MirrorType, localId: string): Record<string, string> {
  return {
    [MIRROR_PROPERTIES.managed]: "1",
    [MIRROR_PROPERTIES.type]: type,
    [MIRROR_PROPERTIES.localId]: localId,
    [MIRROR_PROPERTIES.version]: MIRROR_VERSION,
  };
}

const allDay = (date: ISODate): { start: GoogleTime; end: GoogleTime } => ({ start: { date }, end: { date: addDays(date, 1) } });

/**
 * A TRAZA event in Google. Timed events are local Atlantic/Canary times (Google applies the right
 * offset); an event without an end time ends when it starts (no duration is invented). The visible
 * description is the event's own text plus a restrained "TRAZA · <project>" line: no ids.
 */
export function eventMirrorBody(event: LocalEvent, projectName: string | null): GoogleEventBody {
  const footer = ["TRAZA", projectName].filter(Boolean).join(" · ");
  const start = event.start_time?.slice(0, 5) ?? "00:00";
  const timing = event.all_day
    ? allDay(event.event_date)
    : {
        start: { dateTime: localDateTime(event.event_date, start), timeZone: APP_TIME_ZONE },
        end: { dateTime: localDateTime(event.event_date, event.end_time?.slice(0, 5) ?? start), timeZone: APP_TIME_ZONE },
      };
  return {
    summary: event.title,
    description: event.description ? `${event.description}\n\n${footer}` : footer,
    location: event.location,
    ...timing,
    transparency: "opaque",
    status: "confirmed",
    extendedProperties: { private: privateProperties("calendar_event", event.id) },
  };
}

/** "Tarea de TRAZA · Taller 3 · Campus · Hecha": the only place completion shows in Google. */
export function taskMirrorLine(task: Pick<LocalTask, "status" | "source">, projectName: string | null): string {
  return ["Tarea de TRAZA", projectName, task.source === "canvas" && "Campus", task.status === "done" && "Hecha"].filter(Boolean).join(" · ");
}

/**
 * A task deadline in Google: an ALL-DAY event on its due date (tasks have no due time, so none is
 * invented), marked "free" so it does not block the day. The title is the task's own title.
 */
export function taskMirrorBody(task: LocalTask & { due_date: ISODate }, projectName: string | null): GoogleEventBody {
  return {
    summary: task.title,
    description: taskMirrorLine(task, projectName),
    location: null,
    ...allDay(task.due_date),
    transparency: "transparent",
    status: "confirmed",
    extendedProperties: { private: privateProperties("task", task.id) },
  };
}

/** sha256 of what TRAZA writes, in a fixed field order. */
export function contentHash(body: GoogleEventBody): string {
  const props = Object.entries(body.extendedProperties.private).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify([body.summary, body.description, body.location, body.start, body.end, body.transparency, props]))
    .digest("hex");
}

function sameTime(actual: GoogleTime | null, desired: GoogleTime): boolean {
  if (!actual) return false;
  if ("date" in desired) return "date" in actual && actual.date === desired.date;
  if (!("dateTime" in actual)) return false;
  const [date, time] = desired.dateTime.split("T");
  return parseGoogleDateTime(actual.dateTime, actual.timeZone) === instantOfWallClock(date, time.slice(0, 5), desired.timeZone ?? APP_TIME_ZONE);
}

/** Whether a Google event already shows exactly what TRAZA would write (compared by meaning). */
export function mirrorMatches(actual: GoogleEvent, body: GoogleEventBody): boolean {
  return (
    actual.status !== "cancelled" &&
    (actual.summary ?? "") === body.summary &&
    (actual.description ?? "") === body.description &&
    (actual.location ?? null) === (body.location ?? null) &&
    actual.transparency === body.transparency &&
    sameTime(actual.start, body.start) &&
    sameTime(actual.end, body.end) &&
    Object.entries(body.extendedProperties.private).every(([key, value]) => actual.privateProperties[key] === value)
  );
}

// ---------------------------------------------------------------------------
// Google → TRAZA: imported event content
// ---------------------------------------------------------------------------

/** What sync_google_calendar_events receives for one Google-origin event. */
export type ImportedEventWrite = {
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  event_date: ISODate;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
};

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clip(value: string, max: number): string {
  return [...value].slice(0, max).join("").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Google descriptions may be HTML (the Google Calendar editor writes it). TRAZA stores plain text:
 * line breaks are kept, every tag is removed, common entities are decoded. Never rendered as HTML.
 */
export function plainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "· ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(CONTROL, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function singleLine(value: string | null, max: number): string | null {
  const cleaned = value ? clip(value.replace(CONTROL, "").replace(/\s+/g, " "), max) : "";
  return cleaned || null;
}

/**
 * The TRAZA fields of an independent Google event, or null when it cannot be represented safely
 * (unknown time shape, impossible date, unusable id): such events are skipped and counted.
 *   all-day        start.date is the TRAZA date (a multi-day event shows on its first day);
 *   timed          start/end instants become Atlantic/Canary wall-clock values; an end on another
 *                  local day (overnight) is dropped rather than misplaced.
 */
export function toImportedEvent(event: GoogleEvent): ImportedEventWrite | null {
  if (!IMPORTABLE_EVENT_ID.test(event.id) || event.status === "cancelled" || !event.start) return null;

  let date: ISODate;
  let startTime: string | null = null;
  let endTime: string | null = null;
  if ("date" in event.start) {
    if (!isValidISODate(event.start.date)) return null;
    date = event.start.date;
  } else {
    const instant = parseGoogleDateTime(event.start.dateTime, event.start.timeZone);
    if (instant === null) return null;
    const start = wallClockAt(instant);
    date = start.date;
    startTime = start.time;
    const endInstant = event.end && "dateTime" in event.end ? parseGoogleDateTime(event.end.dateTime, event.end.timeZone) : null;
    if (endInstant !== null && endInstant >= instant) {
      const end = wallClockAt(endInstant);
      if (end.date === date) endTime = end.time;
    }
  }
  if (date < "2000-01-01" || date > "2100-12-31") return null;

  const description = event.description ? clip(plainText(event.description), 2000) : "";
  return {
    event_id: event.id,
    title: singleLine(event.summary, 200) ?? "Sin título",
    description: description || null,
    location: singleLine(event.location, 200),
    event_date: date,
    all_day: startTime === null,
    start_time: startTime,
    end_time: endTime,
  };
}

/** Whether the stored Google-origin event already has these values. */
export function importedMatches(local: LocalEvent, write: ImportedEventWrite): boolean {
  return (
    local.title === write.title &&
    local.description === write.description &&
    local.location === write.location &&
    local.event_date === write.event_date &&
    local.all_day === write.all_day &&
    (local.start_time?.slice(0, 5) ?? null) === write.start_time &&
    (local.end_time?.slice(0, 5) ?? null) === write.end_time
  );
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type PlanInput = {
  /** The user's selected Google calendar. */
  calendarId: string;
  window: SyncWindow;
  /** TRAZA-origin events (source ≠ google-calendar): those in the window plus every linked one. */
  events: LocalEvent[];
  /** Tasks with a due date in the window plus every linked task. */
  tasks: LocalTask[];
  /** Google-origin events (source = google-calendar) of the user, any calendar, any date. */
  imported: LocalEvent[];
  /** Every link of the user, every calendar (tombstones included). */
  links: ItemLink[];
  projectNames: Map<string, string>;
  /** The selected calendar's events in the listing range (cancelled ones included). */
  google: GoogleEvent[];
};

/** What the user may see about a TRAZA item: its own title and date. No ids. */
export type ItemRef = { itemType: MirrorType; localId: string; title: string; date: ISODate };

export type PlanAction =
  /** A TRAZA item without a mirror in this calendar. */
  | { kind: "createGoogleEvent"; item: ItemRef; eventId: string; body: GoogleEventBody; hash: string }
  /** The mirror differs from TRAZA (edited on either side, deleted or moved in Google): rewrite it. linkId null = adopt an unlinked mirror. */
  | { kind: "updateGoogleEvent"; item: ItemRef; eventId: string; linkId: string | null; body: GoogleEventBody; hash: string }
  /** The TRAZA item is gone (tombstone) or the task lost its due date: remove the mirror. */
  | { kind: "deleteGoogleEvent"; linkId: string; eventId: string; itemType: MirrorType; reason: "item-deleted" | "no-date"; title: string | null }
  /** A new independent Google event → new TRAZA event. */
  | { kind: "importGoogleEvent"; write: ImportedEventWrite }
  /** A Google event changed → its existing TRAZA event is updated (same row, never a new one). */
  | { kind: "updateGoogleMirror"; write: ImportedEventWrite }
  /** Nothing to change. For mirrors, the link may still need recording (adoption) or a new hash. */
  | { kind: "unchanged"; side: "mirror"; item: ItemRef; eventId: string; linkId: string | null; hash: string; refreshLink: boolean }
  | { kind: "unchanged"; side: "import" }
  /** Not touched: unreadable Google data, or a TRAZA-marked event whose item is unknown/duplicated. */
  | { kind: "skipped"; reason: "unreadable" | "unknown-mirror" | "duplicate-mirror" }
  /** Reported only: a Google-origin event no longer listed (or deleted) in Google. Never deleted here. */
  | { kind: "warning"; reason: "missing-in-google"; title: string; date: ISODate };

export type SyncPlan = {
  actions: PlanAction[];
  /** Links to calendars that are no longer selected: kept, never matched, never acted on. */
  otherCalendarLinks: number;
};

function byLocalId<K extends "task_id" | "calendar_event_id">(links: ItemLink[], key: K): Map<string, ItemLink> {
  const map = new Map<string, ItemLink>();
  for (const link of links) {
    const id = link[key];
    if (id) map.set(id, link);
  }
  return map;
}

/**
 * Decides every change of one manual sync. Order of the result: Google imports, mirror deletions,
 * mirror creations/updates, then the rest. Deterministic for a given input.
 */
export function planSync(input: PlanInput): SyncPlan {
  const { calendarId, window } = input;
  const links = input.links.filter((link) => link.google_calendar_id === calendarId);
  const linkByTask = byLocalId(links, "task_id");
  const linkByEvent = byLocalId(links, "calendar_event_id");
  const linkedGoogleIds = new Set(links.map((link) => link.google_event_id));
  const googleById = new Map(input.google.map((event) => [event.id, event]));

  // Unlinked events carrying TRAZA's marker, by the item they claim (crash recovery / adoption).
  const claims = new Map<string, GoogleEvent[]>();
  for (const event of [...input.google].sort((a, b) => a.id.localeCompare(b.id))) {
    if (linkedGoogleIds.has(event.id) || !isTrazaManaged(event)) continue;
    const claim = mirrorClaim(event);
    if (!claim) continue;
    const key = `${claim.type}:${claim.localId}`;
    claims.set(key, [...(claims.get(key) ?? []), event]);
  }
  const adopted = new Set<string>();

  const deletions: PlanAction[] = [];
  const mirrors: PlanAction[] = [];

  function planMirror(item: ItemRef, link: ItemLink | undefined, body: GoogleEventBody) {
    const hash = contentHash(body);
    if (link) {
      const actual = googleById.get(link.google_event_id);
      const listedAlive = actual && actual.status !== "cancelled";
      const unchanged = listedAlive ? mirrorMatches(actual, body) : !actual && !inWindow(item.date, window) && link.content_hash === hash;
      // Not listed although inside the window: deleted for good or moved away in Google → rewrite.
      mirrors.push(
        unchanged
          ? { kind: "unchanged", side: "mirror", item, eventId: link.google_event_id, linkId: link.id, hash, refreshLink: link.content_hash !== hash }
          : { kind: "updateGoogleEvent", item, eventId: link.google_event_id, linkId: link.id, body, hash },
      );
      return;
    }
    const ownId = mirrorEventId(item.itemType, item.localId, calendarId);
    const candidates = claims.get(`${item.itemType}:${item.localId}`) ?? [];
    const existing = googleById.get(ownId) ?? candidates[0];
    if (existing) {
      adopted.add(existing.id);
      mirrors.push(
        mirrorMatches(existing, body)
          ? { kind: "unchanged", side: "mirror", item, eventId: existing.id, linkId: null, hash, refreshLink: true }
          : { kind: "updateGoogleEvent", item, eventId: existing.id, linkId: null, body, hash },
      );
      return;
    }
    mirrors.push({ kind: "createGoogleEvent", item, eventId: ownId, body, hash });
  }

  // TRAZA events (never Google-origin ones).
  for (const event of input.events) {
    if (event.source === GOOGLE_EVENT_SOURCE) continue;
    const link = linkByEvent.get(event.id);
    if (!link && !inWindow(event.event_date, window)) continue;
    const projectName = event.project_id ? (input.projectNames.get(event.project_id) ?? null) : null;
    planMirror({ itemType: "calendar_event", localId: event.id, title: event.title, date: event.event_date }, link, eventMirrorBody(event, projectName));
  }

  // Task deadlines.
  for (const task of input.tasks) {
    const link = linkByTask.get(task.id);
    if (!task.due_date) {
      if (link) deletions.push({ kind: "deleteGoogleEvent", linkId: link.id, eventId: link.google_event_id, itemType: "task", reason: "no-date", title: task.title });
      continue;
    }
    if (!link && !inWindow(task.due_date, window)) continue;
    const projectName = task.project_id ? (input.projectNames.get(task.project_id) ?? null) : null;
    planMirror({ itemType: "task", localId: task.id, title: task.title, date: task.due_date }, link, taskMirrorBody({ ...task, due_date: task.due_date }, projectName));
  }

  // Tombstones: the TRAZA item was deleted; its mirror goes too.
  for (const link of links) {
    if (link.task_id === null && link.calendar_event_id === null) {
      deletions.push({
        kind: "deleteGoogleEvent",
        linkId: link.id,
        eventId: link.google_event_id,
        itemType: link.item_type === "task" ? "task" : "calendar_event",
        reason: "item-deleted",
        title: googleById.get(link.google_event_id)?.summary ?? null,
      });
    }
  }

  // Independent Google events → TRAZA.
  const importedByExternalId = new Map(input.imported.map((event) => [event.external_id, event]));
  const imports: PlanAction[] = [];
  const rest: PlanAction[] = [];
  for (const event of input.google) {
    if (linkedGoogleIds.has(event.id) || adopted.has(event.id)) continue;
    if (isTrazaManaged(event)) {
      // Marked by TRAZA but not adopted: a second copy of a mirrored item, or an item TRAZA no
      // longer has. Left alone (never imported as an independent event, never deleted).
      if (event.status !== "cancelled") {
        const claim = mirrorClaim(event);
        const known = claim && (claim.type === "task" ? linkByTask.has(claim.localId) : linkByEvent.has(claim.localId));
        rest.push({ kind: "skipped", reason: known ? "duplicate-mirror" : "unknown-mirror" });
      }
      continue;
    }
    if (event.status === "cancelled") continue;
    const write = toImportedEvent(event);
    if (!write) {
      rest.push({ kind: "skipped", reason: "unreadable" });
      continue;
    }
    const existing = importedByExternalId.get(importedExternalId(calendarId, event.id));
    if (existing) {
      imports.push(importedMatches(existing, write) ? { kind: "unchanged", side: "import" } : { kind: "updateGoogleMirror", write });
    } else if (inWindow(write.event_date, window)) {
      imports.push({ kind: "importGoogleEvent", write });
    }
  }

  // Google-origin events of this calendar that Google no longer lists (or lists as deleted):
  // reported, never deleted from one listing.
  const prefix = importedExternalId(calendarId, "");
  for (const local of input.imported) {
    if (!local.external_id?.startsWith(prefix) || !inWindow(local.event_date, window)) continue;
    const googleId = local.external_id.slice(prefix.length);
    const listed = googleById.get(googleId);
    if (!listed || listed.status === "cancelled") rest.push({ kind: "warning", reason: "missing-in-google", title: local.title, date: local.event_date });
  }

  return {
    actions: [...imports, ...deletions, ...mirrors, ...rest],
    otherCalendarLinks: input.links.length - links.length,
  };
}
