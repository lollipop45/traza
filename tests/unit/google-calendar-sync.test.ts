// Manual Google Calendar sync: time zones, mirror content, Google → TRAZA mapping, the planner and
// the executor, against a FAKE Google Calendar server (in-memory events) and an in-memory TRAZA
// store with the database's link/tombstone semantics. No network, no real account, fake secrets.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { ConnectionMetadata, ConnectionStore, StoredCredentials } from "@/lib/google-calendar/connection";
import { encryptSecret, tokenContext } from "@/lib/google-calendar/crypto";
import { readGoogleCalendarConfig, type GoogleCalendarConfig } from "@/lib/google-calendar/env";
import { parseGoogleEvent, type GoogleEvent } from "@/lib/google-calendar/events";
import { runGoogleSync, type GoogleSyncDeps, type GoogleSyncSummary, type SyncStore } from "@/lib/google-calendar/sync";
import { summaryLines, summaryNotes } from "@/lib/google-calendar/sync-format";
import {
  contentHash,
  eventMirrorBody,
  importedExternalId,
  mirrorEventId,
  mirrorMatches,
  planSync,
  plainText,
  taskMirrorBody,
  taskMirrorLine,
  toImportedEvent,
  type ItemLink,
  type LocalEvent,
  type LocalTask,
} from "@/lib/google-calendar/sync-model";
import { instantOfWallClock, listingRange, parseGoogleDateTime, syncWindow, wallClockAt } from "@/lib/google-calendar/time";
import type { FetchLike } from "@/lib/google-calendar/types";

const USER = "00000000-0000-4000-8000-00000000000a";
const NOW = Date.parse("2026-10-06T10:00:00Z");
const TODAY = "2026-10-06";
const CAL = "traza123@group.calendar.google.com";
const OLD_CAL = "ana@example.com";
const PROJECT = "11111111-1111-4111-8111-111111111111";

const configResult = readGoogleCalendarConfig({
  GOOGLE_CLIENT_ID: "123456789012-fakeclientid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-FAKE-client-secret-not-real",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/integrations/google/callback",
  GOOGLE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});
assert.ok(configResult.ok);
const config: GoogleCalendarConfig = configResult.config;
const ACCESS = "ya29.FAKE-access-token-not-real";
const NEW_ACCESS = "ya29.FAKE-refreshed-access-token";
const REFRESH = "1//0gFAKE-refresh-token-not-real";
const GOOGLE_ERROR_TEXT = "RAW-GOOGLE-ERROR-DETAIL";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// Fake Google Calendar server
// ---------------------------------------------------------------------------

type Resource = Record<string, unknown> & { id: string; status: string };
type Call = { method: string; path: string; eventId: string | null; body: Record<string, unknown> | null; auth: string | null };

/** Google's response form of a local dateTime + timeZone: the same instant with its offset. */
function withOffset(time: Record<string, unknown>): Record<string, unknown> {
  if (typeof time.dateTime !== "string" || typeof time.timeZone !== "string" || /[Zz]|[+-]\d\d:\d\d$/.test(time.dateTime)) return time;
  const [date, clock] = time.dateTime.split("T");
  const instant = instantOfWallClock(date, clock.slice(0, 5), time.timeZone);
  const wall = wallClockAt(instant, time.timeZone);
  const [y, m, d] = wall.date.split("-").map(Number);
  const [hh, mm] = wall.time.split(":").map(Number);
  const offset = Math.round((Date.UTC(y, m - 1, d, hh, mm) - instant) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return { ...time, dateTime: `${wall.date}T${wall.time}:00${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}` };
}

function fakeGoogle(options: { calendarId?: string; pageSize?: number } = {}) {
  const calendarId = options.calendarId ?? CAL;
  const events = new Map<string, Resource>();
  const calls: Call[] = [];
  const state = {
    validTokens: new Set([ACCESS, NEW_ACCESS]),
    refreshRevoked: false,
    down: false,
    /** Fail writes after this many successful ones (simulates Google going down mid-run). */
    failWritesAfter: Infinity,
    writesDone: 0,
  };

  function store(id: string, body: Record<string, unknown>) {
    const resource: Resource = { ...body, id, status: (body.status as string) ?? "confirmed" };
    if (resource.start) resource.start = withOffset(resource.start as Record<string, unknown>);
    if (resource.end) resource.end = withOffset(resource.end as Record<string, unknown>);
    // Google omits the default ("opaque") transparency.
    if (resource.transparency === "opaque") delete resource.transparency;
    events.set(id, resource);
  }

  const fetchFn: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const auth = new Headers(init.headers).get("Authorization");
    const body = typeof init.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (parsed.href.startsWith("https://oauth2.googleapis.com/token")) {
      calls.push({ method: "TOKEN", path: parsed.pathname, eventId: null, body: null, auth: null });
      return state.refreshRevoked ? json({ error: "invalid_grant", error_description: GOOGLE_ERROR_TEXT }, 400) : json({ access_token: NEW_ACCESS, expires_in: 3599, token_type: "Bearer" });
    }
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(parsed.pathname);
    if (!match) return json({ error: GOOGLE_ERROR_TEXT }, 404);
    const method = init.method ?? "GET";
    const eventId = match[2] ? decodeURIComponent(match[2]) : null;
    calls.push({ method, path: parsed.pathname, eventId, body, auth });
    if (!auth || !state.validTokens.has(auth.replace("Bearer ", ""))) return json({ error: GOOGLE_ERROR_TEXT }, 401);
    if (state.down) return json({ error: GOOGLE_ERROR_TEXT }, 503);
    if (decodeURIComponent(match[1]) !== calendarId) return json({ error: GOOGLE_ERROR_TEXT }, 404);

    if (method === "GET" && !eventId) {
      assert.equal(parsed.searchParams.get("singleEvents"), "true");
      assert.equal(parsed.searchParams.get("showDeleted"), "true");
      const all = [...events.values()];
      const offset = Number(parsed.searchParams.get("pageToken") ?? 0);
      const size = options.pageSize ?? 2500;
      const next = offset + size < all.length ? String(offset + size) : undefined;
      return json({ items: all.slice(offset, offset + size), ...(next ? { nextPageToken: next } : {}) });
    }
    if (state.writesDone >= state.failWritesAfter) return json({ error: GOOGLE_ERROR_TEXT }, 503);
    state.writesDone++;
    if (method === "POST" && body) {
      const id = body.id as string;
      if (events.has(id)) return json({ error: GOOGLE_ERROR_TEXT }, 409);
      store(id, body);
      return json(events.get(id));
    }
    if (method === "PUT" && eventId && body) {
      if (!events.has(eventId)) return json({ error: GOOGLE_ERROR_TEXT }, 404);
      store(eventId, body);
      return json(events.get(eventId));
    }
    if (method === "DELETE" && eventId) {
      const existing = events.get(eventId);
      if (!existing) return json({ error: GOOGLE_ERROR_TEXT }, 404);
      if (existing.status === "cancelled") return json({ error: GOOGLE_ERROR_TEXT }, 410);
      events.set(eventId, { id: eventId, status: "cancelled" });
      return new Response(null, { status: 204 });
    }
    return json({ error: GOOGLE_ERROR_TEXT }, 400);
  };

  const writes = () => calls.filter((call) => call.method !== "GET" && call.method !== "TOKEN");
  const managed = () => [...events.values()].filter((event) => event.status !== "cancelled" && (event.extendedProperties as { private?: Record<string, string> })?.private?.trazaManaged === "1");
  return { fetch: fetchFn, calls, events, state, writes, managed, add: (resource: Resource) => events.set(resource.id, resource) };
}

// ---------------------------------------------------------------------------
// In-memory TRAZA (same link semantics as the database: unique keys, tombstones, RPC rules)
// ---------------------------------------------------------------------------

function memoryTraza(selectedCalendarId: string = CAL) {
  const db = {
    events: [] as LocalEvent[],
    tasks: [] as LocalTask[],
    links: [] as ItemLink[],
    projects: new Map([[PROJECT, "Taller 3"]]),
    writes: [] as string[],
    failLinkInserts: false,
  };
  const inRange = (date: string | null, window: { from: string; to: string }) => date !== null && date >= window.from && date <= window.to;
  const store: SyncStore = {
    async loadLinks() {
      return db.links.map((link) => ({ ...link }));
    },
    async loadEvents(window, ids) {
      return db.events.filter((e) => e.source !== "google-calendar" && (inRange(e.event_date, window) || ids.includes(e.id))).map((e) => ({ ...e }));
    },
    async loadTasks(window, ids) {
      return db.tasks.filter((t) => inRange(t.due_date, window) || ids.includes(t.id)).map((t) => ({ ...t }));
    },
    async loadImported() {
      return db.events.filter((e) => e.source === "google-calendar").map((e) => ({ ...e }));
    },
    async loadProjectNames() {
      return new Map(db.projects);
    },
    async insertLink({ calendarId, eventId, itemType, localId, hash }) {
      db.writes.push(`link+ ${itemType}`);
      if (db.failLinkInserts) return "error";
      const exists = itemType === "task" ? db.tasks.some((t) => t.id === localId) : db.events.some((e) => e.id === localId && e.source !== "google-calendar");
      if (!exists) return "error"; // foreign key / trigger
      if (db.links.some((l) => l.google_calendar_id === calendarId && (l.google_event_id === eventId || l.task_id === localId || l.calendar_event_id === localId))) return "exists";
      db.links.push({
        id: randomUUID(),
        google_calendar_id: calendarId,
        google_event_id: eventId,
        item_type: itemType,
        task_id: itemType === "task" ? localId : null,
        calendar_event_id: itemType === "calendar_event" ? localId : null,
        content_hash: hash,
      });
      return "ok";
    },
    async updateLink(linkId, { eventId, hash }) {
      db.writes.push("link~");
      const link = db.links.find((l) => l.id === linkId);
      if (!link) return false;
      link.content_hash = hash;
      if (eventId) link.google_event_id = eventId;
      return true;
    },
    async deleteLink(linkId) {
      db.writes.push("link-");
      db.links = db.links.filter((l) => l.id !== linkId);
      return true;
    },
    async upsertImported(calendarId, writes) {
      db.writes.push("rpc");
      if (calendarId !== selectedCalendarId) return null;
      return writes.map((write) => {
        if (db.links.some((l) => l.google_calendar_id === calendarId && l.google_event_id === write.event_id)) return { event_id: write.event_id, outcome: "mirror" };
        const externalId = importedExternalId(calendarId, write.event_id);
        const values = {
          title: write.title,
          description: write.description,
          location: write.location,
          event_date: write.event_date,
          all_day: write.all_day,
          start_time: write.start_time ? `${write.start_time}:00` : null,
          end_time: write.end_time ? `${write.end_time}:00` : null,
        };
        const existing = db.events.find((e) => e.source === "google-calendar" && e.external_id === externalId);
        if (!existing) {
          db.events.push({ id: randomUUID(), project_id: null, source: "google-calendar", external_id: externalId, ...values });
          return { event_id: write.event_id, outcome: "created" };
        }
        const same = (Object.keys(values) as (keyof typeof values)[]).every((key) => existing[key] === values[key]);
        if (same) return { event_id: write.event_id, outcome: "unchanged" };
        Object.assign(existing, values);
        return { event_id: write.event_id, outcome: "updated" };
      });
    },
  };

  function addEvent(values: Partial<LocalEvent> = {}): LocalEvent {
    const event: LocalEvent = {
      id: randomUUID(),
      title: "Revisión de maqueta",
      description: null,
      event_date: "2026-10-12",
      start_time: "09:00:00",
      end_time: "10:30:00",
      all_day: false,
      location: "Aula 2.4",
      project_id: PROJECT,
      source: "manual",
      external_id: null,
      ...values,
    };
    db.events.push(event);
    return event;
  }
  function addTask(values: Partial<LocalTask> = {}): LocalTask {
    const task: LocalTask = { id: randomUUID(), title: "Panel final", status: "pending", due_date: "2026-10-20", project_id: PROJECT, source: "manual", ...values };
    db.tasks.push(task);
    return task;
  }
  /** Deleting an item: the database clears the link's foreign key (ON DELETE SET NULL) = tombstone. */
  function deleteItem(id: string) {
    db.events = db.events.filter((e) => e.id !== id);
    db.tasks = db.tasks.filter((t) => t.id !== id);
    for (const link of db.links) {
      if (link.task_id === id) link.task_id = null;
      if (link.calendar_event_id === id) link.calendar_event_id = null;
    }
  }
  return { db, store, addEvent, addTask, deleteItem };
}

function memoryConnection(metadata: Partial<ConnectionMetadata> = {}, options: { accessValidFor?: number } = {}) {
  const state = {
    metadata: { status: "connected", accountEmail: "ana@example.com", selectedCalendarId: CAL, selectedCalendarName: "TRAZA", ...metadata } as ConnectionMetadata,
    credentials: {
      refreshCiphertext: encryptSecret(REFRESH, config.keyring, tokenContext(USER, "refresh")),
      accessCiphertext: encryptSecret(ACCESS, config.keyring, tokenContext(USER, "access")),
      accessExpiresAt: new Date(NOW + (options.accessValidFor ?? 30 * 60_000)).toISOString(),
    } as StoredCredentials | null,
    tokenWrites: 0,
  };
  const store: ConnectionStore = {
    loadMetadata: async () => ({ ok: true, metadata: state.metadata }),
    loadCredentials: async () => ({ ok: true, credentials: state.credentials }),
    saveConnection: async () => false,
    saveAccessToken: async (input) => {
      state.tokenWrites++;
      if (state.credentials) state.credentials = { ...state.credentials, accessCiphertext: input.accessCiphertext, accessExpiresAt: input.accessExpiresAt };
      return true;
    },
    markRevoked: async () => {
      state.credentials = null;
      state.metadata = { ...state.metadata, status: "revoked" };
      return true;
    },
    saveSelectedCalendar: async () => false,
    deleteConnection: async () => false,
  };
  return { store, state };
}

function setup(options: { pageSize?: number; metadata?: Partial<ConnectionMetadata>; accessValidFor?: number } = {}) {
  const google = fakeGoogle({ calendarId: options.metadata?.selectedCalendarId ?? CAL, pageSize: options.pageSize });
  const traza = memoryTraza(options.metadata?.selectedCalendarId ?? CAL);
  const connection = memoryConnection(options.metadata, { accessValidFor: options.accessValidFor });
  let counter = 0;
  const deps: GoogleSyncDeps = {
    connection: { config, userId: USER, store: connection.store, fetch: google.fetch, now: () => NOW },
    store: traza.store,
    today: TODAY,
    newEventId: () => `f${String(++counter).padStart(8, "0")}`,
  };
  const sync = async (mode: "preview" | "sync" = "sync") => {
    const result = await runGoogleSync(deps, mode);
    assert.ok(result.ok, result.ok ? "" : result.error);
    return result.summary;
  };
  return { google, traza, connection, deps, sync };
}

/** An independent Google event (no TRAZA marker), as the Google API would list it. */
function independent(id: string, values: Record<string, unknown> = {}): Resource {
  return {
    id,
    status: "confirmed",
    summary: "Clase de estructuras",
    start: { dateTime: "2026-10-14T08:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-10-14T10:00:00Z", timeZone: "UTC" },
    ...values,
  };
}

const counts = (s: GoogleSyncSummary) => ({ events: s.events, tasks: s.tasks, removals: s.removals, imports: s.imports, skipped: s.skipped, missing: s.missingInGoogle });

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

describe("sync window and time zones (Atlantic/Canary)", () => {
  it("uses a bounded window: 30 days back, 365 ahead, with a listing margin", () => {
    assert.deepEqual(syncWindow(TODAY), { from: "2026-09-06", to: "2027-10-06" });
    assert.deepEqual(listingRange(syncWindow(TODAY)), { timeMin: "2026-09-05T00:00:00Z", timeMax: "2027-10-08T00:00:00Z" });
  });

  it("converts Google instants to Canary wall-clock time, summer and winter", () => {
    assert.deepEqual(wallClockAt(Date.parse("2026-10-12T08:00:00Z")), { date: "2026-10-12", time: "09:00" });
    assert.deepEqual(wallClockAt(Date.parse("2026-12-01T08:00:00Z")), { date: "2026-12-01", time: "08:00" });
    // Late UTC evening is already the next day nowhere here, but an offset event can be:
    assert.deepEqual(wallClockAt(parseGoogleDateTime("2026-10-12T23:30:00-03:00", null)!), { date: "2026-10-13", time: "03:30" });
    // Madrid 10:00 in summer is 09:00 in the Canaries.
    assert.deepEqual(wallClockAt(parseGoogleDateTime("2026-10-12T10:00:00+02:00", "Europe/Madrid")!), { date: "2026-10-12", time: "09:00" });
  });

  it("handles both daylight-saving transitions", () => {
    // Spring forward: 29 Mar 2026, 01:00 WET → 02:00 WEST (01:00 UTC).
    assert.deepEqual(wallClockAt(Date.parse("2026-03-29T00:59:00Z")), { date: "2026-03-29", time: "00:59" });
    assert.deepEqual(wallClockAt(Date.parse("2026-03-29T01:00:00Z")), { date: "2026-03-29", time: "02:00" });
    assert.equal(instantOfWallClock("2026-03-28", "10:00"), Date.parse("2026-03-28T10:00:00Z"));
    assert.equal(instantOfWallClock("2026-03-29", "10:00"), Date.parse("2026-03-29T09:00:00Z"));
    // 01:30 does not exist that night: it resolves to the later offset (02:30 local).
    assert.equal(instantOfWallClock("2026-03-29", "01:30"), Date.parse("2026-03-29T01:30:00Z"));
    // Fall back: 25 Oct 2026, 02:00 WEST → 01:00 WET (01:00 UTC); 01:30 happens twice.
    assert.deepEqual(wallClockAt(Date.parse("2026-10-25T00:30:00Z")), { date: "2026-10-25", time: "01:30" });
    assert.deepEqual(wallClockAt(Date.parse("2026-10-25T01:30:00Z")), { date: "2026-10-25", time: "01:30" });
    assert.equal(instantOfWallClock("2026-10-26", "09:00"), Date.parse("2026-10-26T09:00:00Z"));
    assert.equal(instantOfWallClock("2026-10-24", "09:00"), Date.parse("2026-10-24T08:00:00Z"));
  });

  it("parses RFC 3339 strictly; a local dateTime needs a valid time zone", () => {
    assert.equal(parseGoogleDateTime("2026-10-12T09:00:00", "Europe/Madrid"), Date.parse("2026-10-12T07:00:00Z"));
    for (const [value, zone] of [["2026-10-12T09:00:00", null], ["2026-10-12T09:00:00", "Mars/Base"], ["nope", null], ["2026-10-12", null], [42, null]] as const) {
      assert.equal(parseGoogleDateTime(value, zone), null, String(value));
    }
  });
});

// ---------------------------------------------------------------------------
// Mirror content (TRAZA → Google)
// ---------------------------------------------------------------------------

const baseEvent: LocalEvent = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Revisión",
  description: "Llevar planos",
  event_date: "2026-10-12",
  start_time: "09:00:00",
  end_time: "10:30:00",
  all_day: false,
  location: "Aula 2.4",
  project_id: PROJECT,
  source: "manual",
  external_id: null,
};

describe("mirror content", () => {
  it("writes timed TRAZA events as Atlantic/Canary local times; no end means it ends when it starts", () => {
    const body = eventMirrorBody(baseEvent, "Taller 3");
    assert.deepEqual(body.start, { dateTime: "2026-10-12T09:00:00", timeZone: "Atlantic/Canary" });
    assert.deepEqual(body.end, { dateTime: "2026-10-12T10:30:00", timeZone: "Atlantic/Canary" });
    const open = eventMirrorBody({ ...baseEvent, end_time: null }, null);
    assert.deepEqual(open.end, open.start);
    // Across the October change the wall-clock time is kept, never shifted by an offset.
    assert.deepEqual(eventMirrorBody({ ...baseEvent, event_date: "2026-10-26" }, null).start, { dateTime: "2026-10-26T09:00:00", timeZone: "Atlantic/Canary" });
  });

  it("writes all-day dates as plain dates (end exclusive), never converted", () => {
    const body = eventMirrorBody({ ...baseEvent, all_day: true, start_time: null, end_time: null, event_date: "2026-12-31" }, null);
    assert.deepEqual([body.start, body.end], [{ date: "2026-12-31" }, { date: "2027-01-01" }]);
  });

  it("marks mirrors with private extended properties and keeps ids out of the visible text", () => {
    const body = eventMirrorBody(baseEvent, "Taller 3");
    assert.deepEqual(body.extendedProperties.private, { trazaManaged: "1", trazaType: "calendar_event", trazaLocalId: baseEvent.id, trazaVersion: "1" });
    assert.equal(body.summary, "Revisión");
    assert.equal(body.description, "Llevar planos\n\nTRAZA · Taller 3");
    for (const visible of [body.summary, body.description, body.location ?? ""]) assert.ok(!visible.includes(baseEvent.id) && !visible.includes("traza"));
  });

  it("exports task deadlines as all-day, free events with the task's own title", () => {
    const task: LocalTask & { due_date: string } = { id: "33333333-3333-4333-8333-333333333333", title: "PRÁCTICA NÚMERO 3", status: "done", due_date: "2026-10-20", project_id: PROJECT, source: "canvas" };
    const body = taskMirrorBody(task, "Taller 3");
    assert.equal(body.summary, "PRÁCTICA NÚMERO 3");
    assert.deepEqual([body.start, body.end, body.transparency], [{ date: "2026-10-20" }, { date: "2026-10-21" }, "transparent"]);
    assert.equal(body.description, "Tarea de TRAZA · Taller 3 · Campus · Hecha");
    assert.equal(taskMirrorLine({ status: "pending", source: "manual" }, null), "Tarea de TRAZA");
    assert.ok(!JSON.stringify([body.summary, body.description]).includes("course:"));
  });

  it("gives each item a deterministic, valid Google id per calendar and type", () => {
    const id = mirrorEventId("task", baseEvent.id, CAL);
    assert.match(id, /^[a-v0-9]{5,1024}$/);
    assert.equal(id, mirrorEventId("task", baseEvent.id, CAL));
    assert.notEqual(id, mirrorEventId("calendar_event", baseEvent.id, CAL));
    assert.notEqual(id, mirrorEventId("task", baseEvent.id, OLD_CAL));
  });

  it("compares by meaning: Google's offset form of the same instant is unchanged", () => {
    const body = eventMirrorBody(baseEvent, null);
    const listed = parseGoogleEvent({
      id: "x1234",
      status: "confirmed",
      summary: body.summary,
      description: body.description,
      location: body.location,
      start: { dateTime: "2026-10-12T09:00:00+01:00", timeZone: "Atlantic/Canary" },
      end: { dateTime: "2026-10-12T08:30:00-01:00", timeZone: "Atlantic/Canary" },
      extendedProperties: { private: body.extendedProperties.private },
    })!;
    assert.ok(mirrorMatches(listed, body));
    assert.ok(!mirrorMatches({ ...listed, summary: "Editado en Google" }, body));
    assert.ok(!mirrorMatches({ ...listed, status: "cancelled" }, body));
    assert.ok(!mirrorMatches({ ...listed, start: { dateTime: "2026-10-12T09:00:00Z", timeZone: null } }, body));
    assert.notEqual(contentHash(body), contentHash({ ...body, summary: "Otro" }));
  });
});

// ---------------------------------------------------------------------------
// Google → TRAZA mapping
// ---------------------------------------------------------------------------

const listed = (value: Record<string, unknown>): GoogleEvent => parseGoogleEvent({ id: "abc123", status: "confirmed", summary: "Clase", ...value })!;

describe("Google event import mapping", () => {
  it("maps timed events to Canary wall-clock date and times", () => {
    const write = toImportedEvent(listed({ start: { dateTime: "2026-10-14T08:00:00Z" }, end: { dateTime: "2026-10-14T10:00:00Z" }, location: "  ETSA \n Aula 1 " }));
    assert.deepEqual(write, {
      event_id: "abc123",
      title: "Clase",
      description: null,
      location: "ETSA Aula 1",
      event_date: "2026-10-14",
      all_day: false,
      start_time: "09:00",
      end_time: "11:00",
    });
  });

  it("keeps all-day dates exactly and shows multi-day events on their first day", () => {
    const write = toImportedEvent(listed({ start: { date: "2026-10-12" }, end: { date: "2026-10-15" } }));
    assert.deepEqual([write?.event_date, write?.all_day, write?.start_time, write?.end_time], ["2026-10-12", true, null, null]);
  });

  it("drops an end on another local day instead of misplacing it", () => {
    const write = toImportedEvent(listed({ start: { dateTime: "2026-10-14T22:00:00Z" }, end: { dateTime: "2026-10-15T02:00:00Z" } }));
    assert.deepEqual([write?.event_date, write?.start_time, write?.end_time], ["2026-10-14", "23:00", null]);
  });

  it("imports plain text only, never raw HTML", () => {
    assert.equal(plainText("<p>Hola <b>equipo</b></p><ul><li>Maqueta</li><li>Planos &amp; cortes</li></ul>Ver&nbsp;aula&#33;<br>Fin"), "Hola equipo\n· Maqueta\n· Planos & cortes\nVer aula!\nFin");
    const write = toImportedEvent(listed({ start: { date: "2026-10-12" }, description: '<a href="https://x">enlace</a><script>alert(1)</script>' }));
    assert.equal(write?.description, "enlacealert(1)");
    assert.ok(!write?.description?.includes("<"));
  });

  it("bounds lengths and names untitled events", () => {
    const write = toImportedEvent(listed({ summary: "x".repeat(300), start: { date: "2026-10-12" }, description: "d".repeat(3000) }));
    assert.equal([...write!.title].length, 200);
    assert.equal(write!.description!.length, 2000);
    assert.equal(toImportedEvent(listed({ summary: "   ", start: { date: "2026-10-12" } }))?.title, "Sin título");
  });

  it("skips what it cannot represent safely", () => {
    for (const bad of [
      { start: undefined },
      { start: { date: "2026-02-30" } },
      { start: { dateTime: "mañana" } },
      { start: { date: "1999-12-31" } },
      { status: "cancelled", start: { date: "2026-10-12" } },
      { id: "bad id/with slash", start: { date: "2026-10-12" } },
    ]) {
      assert.equal(toImportedEvent(listed(bad)), null, JSON.stringify(bad));
    }
  });
});

// ---------------------------------------------------------------------------
// Preview and sync, end to end against the fake Google
// ---------------------------------------------------------------------------

describe("preview", () => {
  it("performs zero writes to Google and to TRAZA", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    traza.addTask();
    traza.addTask({ title: "PRÁCTICA NÚMERO 3", source: "canvas", due_date: "2026-10-22" });
    traza.addTask({ title: "Sin fecha", due_date: null });
    google.add(independent("indep1"));
    const before = JSON.stringify(traza.db);

    const summary = await sync("preview");
    assert.equal(summary.mode, "preview");
    assert.deepEqual(counts(summary), {
      events: { create: 1, update: 0, unchanged: 0 },
      tasks: { create: 2, update: 0, unchanged: 0 },
      removals: 0,
      imports: { create: 1, update: 0, unchanged: 0 },
      skipped: 0,
      missing: 0,
    });
    assert.deepEqual(google.writes(), []);
    assert.ok(google.calls.every((call) => call.method === "GET"));
    assert.equal(JSON.stringify(traza.db), before);
    assert.deepEqual(traza.db.writes, []);
    assert.deepEqual(summaryLines(summary), ["1 evento TRAZA se crearía", "2 tareas se enviarían", "1 evento de Google se importaría", "0 sin cambios"]);
  });

  it("predicts exactly what the sync then does (one planner)", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    traza.addEvent({ title: "Entrega", all_day: true, start_time: null, end_time: null, event_date: "2026-10-30" });
    traza.addTask();
    google.add(independent("indep1"));
    google.add(independent("indep2", { summary: "Tutoría", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } }));
    const preview = await sync("preview");
    const done = await sync("sync");
    assert.deepEqual(counts(done), counts(preview));
    assert.deepEqual(
      done.details.map(({ group, title, date }) => ({ group, title, date })),
      preview.details.map(({ group, title, date }) => ({ group, title, date })),
    );
    assert.equal(done.failed, 0);
  });
});

describe("sync: identity and duplicates", () => {
  it("creates one Google event per item and nothing more on repeated syncs", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    traza.addTask();
    traza.addTask({ title: "PRÁCTICA NÚMERO 3", source: "canvas", due_date: "2026-10-22" });
    google.add(independent("indep1"));

    const first = await sync();
    assert.deepEqual([first.events.create, first.tasks.create, first.imports.create], [1, 2, 1]);
    assert.equal(google.managed().length, 3);
    assert.equal(traza.db.links.length, 3);
    assert.equal(traza.db.events.filter((e) => e.source === "google-calendar").length, 1);

    const writesBefore = google.writes().length;
    for (let run = 0; run < 3; run++) {
      const again = await sync();
      assert.deepEqual(counts(again), {
        events: { create: 0, update: 0, unchanged: 1 },
        tasks: { create: 0, update: 0, unchanged: 2 },
        removals: 0,
        imports: { create: 0, update: 0, unchanged: 1 },
        skipped: 0,
        missing: 0,
      });
    }
    assert.equal(google.writes().length, writesBefore, "no Google write when nothing changed");
    assert.equal(google.managed().length, 3);
    assert.equal(traza.db.links.length, 3);
    assert.equal(traza.db.events.filter((e) => e.source === "google-calendar").length, 1);
  });

  it("never confuses a task and an event with the same title, or two Google events with the same title", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent({ title: "Entrega", event_date: "2026-10-20" });
    traza.addTask({ title: "Entrega", due_date: "2026-10-20" });
    google.add(independent("same1", { summary: "Clase" }));
    google.add(independent("same2", { summary: "Clase" }));
    await sync();
    await sync();
    assert.equal(google.managed().length, 2);
    assert.deepEqual(new Set(google.managed().map((e) => (e.extendedProperties as { private: Record<string, string> }).private.trazaType)), new Set(["task", "calendar_event"]));
    const imported = traza.db.events.filter((e) => e.source === "google-calendar");
    assert.deepEqual(imported.map((e) => e.external_id).sort(), [importedExternalId(CAL, "same1"), importedExternalId(CAL, "same2")]);
  });

  it("stays duplicate-free when two syncs run at the same time", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    traza.addTask();
    google.add(independent("indep1"));
    await Promise.all([sync(), sync()]);
    await sync();
    assert.equal(google.managed().length, 2);
    assert.equal(traza.db.links.length, 2);
    assert.equal(traza.db.events.filter((e) => e.source === "google-calendar").length, 1);
  });

  it("adopts a mirror whose link was never recorded (crash between Google and TRAZA)", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    traza.db.failLinkInserts = true;
    const failed = await sync();
    assert.equal(failed.failed, 1);
    assert.equal(google.managed().length, 1);
    assert.equal(traza.db.links.length, 0);

    traza.db.failLinkInserts = false;
    const recovered = await sync();
    assert.equal(recovered.events.create, 0);
    assert.equal(recovered.events.unchanged, 1);
    assert.equal(google.managed().length, 1, "no duplicate");
    assert.equal(traza.db.links.length, 1);
  });
});

describe("sync: ownership by origin", () => {
  it("pushes TRAZA edits to the same Google event", async () => {
    const { google, traza, sync } = setup();
    const event = traza.addEvent();
    await sync();
    const [mirror] = google.managed();
    event.title = "Revisión aplazada";
    event.start_time = "11:00:00";
    event.end_time = null;
    const summary = await sync();
    assert.equal(summary.events.update, 1);
    assert.equal(google.managed().length, 1);
    const updated = google.events.get(mirror.id)!;
    assert.equal(updated.summary, "Revisión aplazada");
    assert.deepEqual(updated.start, { dateTime: "2026-10-12T11:00:00+01:00", timeZone: "Atlantic/Canary" });
  });

  it("restores TRAZA-owned values when the mirror is edited or deleted in Google", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    const task = traza.addTask({ status: "done" });
    await sync();
    const [first, second] = google.managed();
    google.events.set(first.id, { ...first, summary: "Cambiado en Google" });
    google.events.set(second.id, { id: second.id, status: "cancelled" });
    const summary = await sync();
    assert.equal(summary.events.update + summary.tasks.update, 2);
    assert.equal(google.managed().length, 2);
    assert.ok(google.managed().every((event) => event.summary !== "Cambiado en Google"));
    // Google never changes the task: still done, untouched.
    assert.deepEqual(traza.db.tasks.find((t) => t.id === task.id), task);
  });

  it("recreates a mirror that is gone for good, and repoints its link", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    await sync();
    const [mirror] = google.managed();
    google.events.delete(mirror.id);
    const summary = await sync();
    assert.equal(summary.events.update, 1);
    assert.equal(google.managed().length, 1);
    assert.equal(traza.db.links[0].google_event_id, google.managed()[0].id);
  });

  it("never re-exports a Google-origin event, and updates the same TRAZA event when Google changes", async () => {
    const { google, traza, sync } = setup();
    google.add(independent("indep1"));
    await sync();
    const imported = traza.db.events.find((e) => e.source === "google-calendar")!;
    assert.deepEqual([imported.title, imported.event_date, imported.start_time, imported.end_time, imported.project_id], ["Clase de estructuras", "2026-10-14", "09:00:00", "11:00:00", null]);
    assert.equal(google.writes().length, 0, "nothing written to Google for an imported event");

    imported.project_id = PROJECT; // the user's own TRAZA field
    google.events.set("indep1", { ...google.events.get("indep1")!, summary: "Clase cambiada", start: { dateTime: "2026-10-14T09:00:00Z" } });
    const summary = await sync();
    assert.equal(summary.imports.update, 1);
    const again = traza.db.events.filter((e) => e.source === "google-calendar");
    assert.equal(again.length, 1);
    assert.equal(again[0].id, imported.id);
    assert.deepEqual([again[0].title, again[0].start_time, again[0].project_id], ["Clase cambiada", "10:00:00", PROJECT]);
  });

  it("ignores TRAZA-marked events it cannot place instead of importing them", async () => {
    const { google, traza, sync } = setup();
    google.add(
      independent("orphan1", {
        extendedProperties: { private: { trazaManaged: "1", trazaType: "task", trazaLocalId: "44444444-4444-4444-8444-444444444444", trazaVersion: "1" } },
      }),
    );
    const summary = await sync();
    assert.deepEqual([summary.imports.create, summary.skipped], [0, 1]);
    assert.equal(traza.db.events.length, 0);
    assert.ok(google.events.has("orphan1"), "never deleted");
    assert.match(summaryNotes(summary).join(" "), /se omite/);
  });
});

describe("sync: task deadlines", () => {
  it("exports manual and Canvas tasks with a date as all-day events; undated tasks stay out", async () => {
    const { google, traza, sync } = setup();
    const canvas = traza.addTask({ title: "PRÁCTICA NÚMERO 3", source: "canvas", due_date: "2026-10-22" });
    traza.addTask({ title: "Manual" });
    traza.addTask({ title: "Sin fecha", due_date: null });
    traza.addTask({ title: "Muy antigua", due_date: "2025-01-10" });
    const canvasBefore = { ...canvas };
    await sync();
    const mirrors = google.managed();
    assert.deepEqual(mirrors.map((m) => m.summary).sort(), ["Manual", "PRÁCTICA NÚMERO 3"]);
    const practica = mirrors.find((m) => m.summary === "PRÁCTICA NÚMERO 3")!;
    assert.deepEqual([practica.start, practica.end, practica.transparency], [{ date: "2026-10-22" }, { date: "2026-10-23" }, "transparent"]);
    assert.equal(practica.description, "Tarea de TRAZA · Taller 3 · Campus");
    // Canvas → TRAZA → Google: the Campus task itself is never touched.
    assert.deepEqual(traza.db.tasks.find((t) => t.id === canvas.id), canvasBefore);
  });

  it("shows completion in the description only, and keeps the deadline", async () => {
    const { google, traza, sync } = setup();
    const task = traza.addTask();
    await sync();
    task.status = "done";
    const summary = await sync();
    assert.equal(summary.tasks.update, 1);
    const [mirror] = google.managed();
    assert.equal(mirror.summary, "Panel final");
    assert.equal(mirror.description, "Tarea de TRAZA · Taller 3 · Hecha");
  });
});

describe("sync: deletions", () => {
  it("deleting a TRAZA event or task leaves a tombstone; the next sync removes the mirror", async () => {
    const { google, traza, sync } = setup();
    const event = traza.addEvent();
    const task = traza.addTask();
    await sync();
    traza.deleteItem(event.id);
    traza.deleteItem(task.id);
    assert.ok(traza.db.links.every((link) => link.task_id === null && link.calendar_event_id === null));

    const preview = await sync("preview");
    assert.equal(preview.removals, 2);
    assert.equal(google.managed().length, 2, "preview deletes nothing");

    const summary = await sync();
    assert.equal(summary.removals, 2);
    assert.equal(google.managed().length, 0);
    assert.equal(traza.db.links.length, 0);
    assert.equal((await sync()).removals, 0);
  });

  it("removes the mirror of a task whose due date was cleared", async () => {
    const { google, traza, sync } = setup();
    const task = traza.addTask();
    await sync();
    task.due_date = null;
    const summary = await sync();
    assert.equal(summary.removals, 1);
    assert.equal(google.managed().length, 0);
    assert.equal(traza.db.tasks.length, 1, "the task itself stays");
  });

  it("keeps the tombstone when Google cannot delete, and retries next time", async () => {
    const { google, traza, sync } = setup();
    const event = traza.addEvent();
    await sync();
    traza.deleteItem(event.id);
    google.state.down = true;
    const result = await runGoogleSync(setupDepsFrom(google, traza), "sync");
    assert.equal(result.ok, false);
    google.state.down = false;
    google.state.failWritesAfter = google.state.writesDone;
    const failed = await sync();
    assert.equal(failed.removals, 0);
    assert.equal(failed.failed, 1);
    assert.equal(traza.db.links.length, 1);
    google.state.failWritesAfter = Infinity;
    assert.equal((await sync()).removals, 1);
    assert.equal(traza.db.links.length, 0);
  });

  it("never deletes a Google-origin event's TRAZA copy because Google stopped listing it", async () => {
    const { google, traza, sync } = setup();
    google.add(independent("gone1"));
    google.add(independent("gone2", { summary: "Otra" }));
    await sync();
    google.events.delete("gone1");
    google.events.set("gone2", { id: "gone2", status: "cancelled" });
    const summary = await sync();
    assert.equal(summary.missingInGoogle, 2);
    assert.equal(traza.db.events.filter((e) => e.source === "google-calendar").length, 2);
    assert.match(summaryNotes(summary).join(" "), /no se borran solos/);
  });
});

describe("sync: calendar changes", () => {
  it("leaves links to a previous calendar alone and mirrors into the new one", async () => {
    const { google, traza, sync } = setup();
    const event = traza.addEvent();
    traza.db.links.push({
      id: randomUUID(),
      google_calendar_id: OLD_CAL,
      google_event_id: mirrorEventId("calendar_event", event.id, OLD_CAL),
      item_type: "calendar_event",
      task_id: null,
      calendar_event_id: event.id,
      content_hash: "0".repeat(64),
    });
    const summary = await sync();
    assert.equal(summary.events.create, 1);
    assert.equal(summary.otherCalendarLinks, 1);
    assert.equal(traza.db.links.length, 2);
    assert.ok(google.calls.every((call) => !call.path.includes(encodeURIComponent(OLD_CAL))));
    assert.match(summaryNotes(summary).join(" "), /calendario elegido antes/);
  });
});

/** Same deps as setup(), rebuilt around an existing fake Google and TRAZA. */
function setupDepsFrom(google: ReturnType<typeof fakeGoogle>, traza: ReturnType<typeof memoryTraza>): GoogleSyncDeps {
  return { connection: { config, userId: USER, store: memoryConnection().store, fetch: google.fetch, now: () => NOW }, store: traza.store, today: TODAY };
}

describe("sync: failures", () => {
  it("writes nothing when Google is unavailable, without echoing Google's error", async () => {
    const { google, traza, deps } = setup();
    traza.addEvent();
    google.state.down = true;
    const result = await runGoogleSync(deps, "sync");
    assert.deepEqual(result, { ok: false, error: "Google Calendar no está disponible en este momento. No se ha cambiado nada." });
    assert.deepEqual(traza.db.writes, []);
  });

  it("handles a revoked access: Acceso retirado, local data intact", async () => {
    const { google, traza, connection, deps } = setup({ accessValidFor: 0 });
    traza.addEvent();
    google.state.refreshRevoked = true;
    const before = JSON.stringify(traza.db);
    const result = await runGoogleSync(deps, "sync");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /^Acceso retirado/);
    assert.equal(connection.state.metadata.status, "revoked");
    assert.equal(JSON.stringify(traza.db), before);
    assert.ok(!JSON.stringify(result).includes(GOOGLE_ERROR_TEXT));
  });

  it("refuses to run without a chosen calendar or connection", async () => {
    for (const metadata of [{ selectedCalendarId: null, selectedCalendarName: null }, { status: "revoked" }]) {
      const { deps, google } = setup({ metadata });
      const result = await runGoogleSync(deps, "preview");
      assert.equal(result.ok, false);
      assert.equal(google.calls.length, 0);
    }
  });

  it("retries once with a refreshed token when Google rejects the stored one", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    google.state.validTokens = new Set([NEW_ACCESS]);
    const summary = await sync();
    assert.equal(summary.events.create, 1);
    assert.equal(google.calls.filter((call) => call.method === "TOKEN").length, 1);
  });

  it("stops cleanly when Google fails mid-run; the next sync finishes without duplicates", async () => {
    const { google, traza, sync } = setup();
    traza.addEvent();
    traza.addEvent({ title: "Segunda", event_date: "2026-10-13" });
    traza.addTask();
    google.state.failWritesAfter = 1;
    const partial = await sync();
    assert.equal(partial.incomplete, true);
    assert.equal(partial.events.create + partial.tasks.create, 1);
    assert.ok(!JSON.stringify(partial).includes(GOOGLE_ERROR_TEXT));
    assert.match(summaryNotes(partial)[0], /incompleta/);
    assert.equal(traza.db.links.length, 1, "only confirmed mirrors are recorded");

    google.state.failWritesAfter = Infinity;
    const finished = await sync();
    assert.equal(finished.events.create + finished.tasks.create, 2);
    assert.equal(google.managed().length, 3);
    assert.equal(traza.db.links.length, 3);
  });

  it("skips malformed Google events safely and follows pagination", async () => {
    const { google, traza, sync } = setup({ pageSize: 2 });
    google.add(independent("ok1"));
    google.add(independent("ok2", { summary: "Dos" }));
    google.add({ id: "bad1", status: "confirmed", summary: "Sin hora" });
    google.add(independent("ok3", { summary: "Tres", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }));
    const summary = await sync();
    assert.deepEqual([summary.imports.create, summary.skipped], [3, 1]);
    assert.equal(traza.db.events.length, 3);
    assert.equal(google.calls.filter((call) => call.method === "GET").length, 2);
  });
});

describe("sync results", () => {
  it("carry counts, titles and dates only: no ids, tokens or private metadata", async () => {
    const { google, traza, sync } = setup();
    const event = traza.addEvent();
    const task = traza.addTask();
    google.add(independent("indep1"));
    for (const mode of ["preview", "sync"] as const) {
      const text = JSON.stringify(await sync(mode));
      for (const hidden of [event.id, task.id, "indep1", mirrorEventId("task", task.id, CAL), "trazaManaged", "trazaLocalId", ACCESS, REFRESH, CAL]) {
        assert.ok(!text.includes(hidden), `${mode} exposes ${hidden.slice(0, 16)}`);
      }
    }
  });

  it("the planner skips Google-origin rows even if handed one as a TRAZA event", () => {
    const plan = planSync({
      calendarId: CAL,
      window: syncWindow(TODAY),
      events: [{ ...baseEvent, source: "google-calendar", external_id: importedExternalId(CAL, "x1") }],
      tasks: [],
      imported: [],
      links: [],
      projectNames: new Map(),
      google: [],
    });
    assert.deepEqual(plan.actions, []);
  });
});
