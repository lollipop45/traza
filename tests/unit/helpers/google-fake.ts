// Shared test doubles for the Google Calendar sync: a FAKE Google Calendar server (in-memory
// events, scripted failures) and an in-memory TRAZA store with the database's link/tombstone
// semantics. No network, no real account, fake secrets. Used by google-calendar-sync.test.ts and
// google-calendar-auto-sync.test.ts.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { ConnectionMetadata, ConnectionStore, StoredCredentials } from "@/lib/google-calendar/connection";
import { encryptSecret, tokenContext } from "@/lib/google-calendar/crypto";
import { readGoogleCalendarConfig, type GoogleCalendarConfig } from "@/lib/google-calendar/env";
import { runGoogleSync, type GoogleSyncDeps, type GoogleSyncSummary, type SyncStore } from "@/lib/google-calendar/sync";
import { importedExternalId, type ItemLink, type LocalEvent, type LocalTask } from "@/lib/google-calendar/sync-model";
import { instantOfWallClock, wallClockAt } from "@/lib/google-calendar/time";
import type { FetchLike } from "@/lib/google-calendar/types";

export const USER = "00000000-0000-4000-8000-00000000000a";
export const NOW = Date.parse("2026-10-06T10:00:00Z");
export const TODAY = "2026-10-06";
export const CAL = "traza123@group.calendar.google.com";
export const OLD_CAL = "ana@example.com";
export const PROJECT = "11111111-1111-4111-8111-111111111111";

export const configResult = readGoogleCalendarConfig({
  GOOGLE_CLIENT_ID: "123456789012-fakeclientid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-FAKE-client-secret-not-real",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/integrations/google/callback",
  GOOGLE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});
assert.ok(configResult.ok);
export const config: GoogleCalendarConfig = configResult.config;
export const ACCESS = "ya29.FAKE-access-token-not-real";
export const NEW_ACCESS = "ya29.FAKE-refreshed-access-token";
export const REFRESH = "1//0gFAKE-refresh-token-not-real";
export const GOOGLE_ERROR_TEXT = "RAW-GOOGLE-ERROR-DETAIL";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// Fake Google Calendar server
// ---------------------------------------------------------------------------

export type Resource = Record<string, unknown> & { id: string; status: string };
export type Call = { method: string; path: string; eventId: string | null; body: Record<string, unknown> | null; auth: string | null };

/** Google's response form of a local dateTime + timeZone: the same instant with its offset. */
export function withOffset(time: Record<string, unknown>): Record<string, unknown> {
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

export function fakeGoogle(options: { calendarId?: string; pageSize?: number } = {}) {
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
    /**
     * Scripted failure for one request (`kind` = "TOKEN" or the HTTP method; `n` = 1-based count of
     * requests of that kind). Returning undefined lets the request through.
     */
    script: undefined as ((kind: string, n: number) => Response | "network" | "timeout" | undefined) | undefined,
    /** Called before each request (e.g. to hold a run "inside Google"). */
    beforeRequest: undefined as (() => Promise<void>) | undefined,
  };
  const perKind = new Map<string, number>();

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
    const kind = parsed.href.startsWith("https://oauth2.googleapis.com/token") ? "TOKEN" : (init.method ?? "GET");
    const n = (perKind.get(kind) ?? 0) + 1;
    perKind.set(kind, n);
    await state.beforeRequest?.();
    const scripted = state.script?.(kind, n);
    if (scripted) {
      calls.push({ method: kind, path: parsed.pathname, eventId: null, body, auth });
      if (scripted === "network") throw new TypeError(`fetch failed ${GOOGLE_ERROR_TEXT}`);
      if (scripted === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return scripted;
    }
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

export function memoryTraza(selectedCalendarId: string = CAL) {
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

export function memoryConnection(metadata: Partial<ConnectionMetadata> = {}, options: { accessValidFor?: number } = {}) {
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

export function setup(options: { pageSize?: number; metadata?: Partial<ConnectionMetadata>; accessValidFor?: number } = {}) {
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
export function independent(id: string, values: Record<string, unknown> = {}): Resource {
  return {
    id,
    status: "confirmed",
    summary: "Clase de estructuras",
    start: { dateTime: "2026-10-14T08:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-10-14T10:00:00Z", timeZone: "UTC" },
    ...values,
  };
}

export const counts = (s: GoogleSyncSummary) => ({ events: s.events, tasks: s.tasks, removals: s.removals, imports: s.imports, skipped: s.skipped, missing: s.missingInGoogle });
