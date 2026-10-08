import { randomBytes } from "node:crypto";
import type { ISODate } from "@/lib/calendar/types";
import { accessFailureMessage, getAccessToken, type AccessFailure, type ConnectionDeps } from "./connection";
import { deleteEvent, insertEvent, listEvents, updateEvent, type GoogleEventBody, type WriteResult } from "./events";
import { mirrorEventId, planSync, type ImportedEventWrite, type ItemLink, type LocalEvent, type LocalTask, type MirrorType, type PlanAction } from "./sync-model";
import { listingRange, syncWindow, type SyncWindow } from "./time";

// THE Google Calendar reconciliation engine: load → plan (sync-model.ts) → preview or execute.
// Shared by "Vista previa Google", "Sincronizar Google Calendar" and the automatic sync
// (lib/google-calendar/auto-sync.ts wraps it with the per-user lease and cooldown); there is no
// second implementation of these rules. Independent of Next.js and Supabase (mocked in tests);
// lib/google-calendar/sync-deps.ts wires the real ones.
//
// Preview performs NO writes: no Google write request and no Supabase write (links, events, tasks).
// The only possible database write during a preview is the existing encrypted access-token cache
// when the token has to be refreshed (or "Acceso retirado" if Google revoked it).
//
// Sync performs the plan's actions one by one. Every database write that records a mirror happens
// only after Google confirmed the event, and mirror ids are deterministic, so an interruption at any
// point leaves nothing that the next sync would duplicate. If Google becomes unavailable or the
// access is lost, the run stops (reported as incomplete); local data is never deleted.

export type SyncMode = "preview" | "sync";

/** Supabase access for the sync (the signed-in user's own rows only; see sync-store.ts). */
export type SyncStore = {
  loadLinks(): Promise<ItemLink[] | null>;
  /** TRAZA-origin events (source ≠ google-calendar) in the window, plus the given ids. */
  loadEvents(window: SyncWindow, ids: string[]): Promise<LocalEvent[] | null>;
  /** Tasks with a due date in the window, plus the given ids. */
  loadTasks(window: SyncWindow, ids: string[]): Promise<LocalTask[] | null>;
  /** Google-origin events (source = google-calendar). */
  loadImported(): Promise<LocalEvent[] | null>;
  loadProjectNames(): Promise<Map<string, string> | null>;
  insertLink(link: { calendarId: string; eventId: string; itemType: MirrorType; localId: string; hash: string }): Promise<"ok" | "exists" | "error">;
  updateLink(linkId: string, values: { eventId?: string; hash: string }): Promise<boolean>;
  deleteLink(linkId: string): Promise<boolean>;
  /** sync_google_calendar_events: one call per chunk. Null on any database error. */
  upsertImported(calendarId: string, writes: ImportedEventWrite[]): Promise<{ event_id: string; outcome: string }[] | null>;
};

export type GoogleSyncDeps = {
  connection: ConnectionDeps;
  store: SyncStore;
  /** Atlantic/Canary calendar day. */
  today: ISODate;
  /** Fresh mirror id when TRAZA's own id cannot be reused (tests make it deterministic). */
  newEventId?: () => string;
};

export type SyncDetailGroup = "event-create" | "event-update" | "task-create" | "task-update" | "removal" | "import-create" | "import-update" | "missing";
/** One line of the restrained details: the user's own title and date. Never an id. */
export type SyncDetail = { group: SyncDetailGroup; title: string; date: ISODate | null };

type Counts = { create: number; update: number; unchanged: number };

export type GoogleSyncSummary = {
  mode: SyncMode;
  calendarName: string;
  window: SyncWindow;
  /** TRAZA events → Google. */
  events: Counts;
  /** Task deadlines → Google (all-day). */
  tasks: Counts;
  /** Mirrors removed from Google: their TRAZA item was deleted, or the task lost its due date. */
  removals: number;
  /** Independent Google events → TRAZA. */
  imports: Counts;
  /** Unreadable Google events, or TRAZA-marked events without a known item: left untouched. */
  skipped: number;
  /** Google-origin events Google no longer lists: reported, kept in TRAZA. */
  missingInGoogle: number;
  /** Links to a previously selected calendar: kept, not acted on. */
  otherCalendarLinks: number;
  /** Sync only: actions that failed (nothing about them was recorded). */
  failed: number;
  /** Sync only: stopped early because Google became unavailable or the access was lost. */
  incomplete: boolean;
  /** Sync only: why it stopped early, as a safe code (null when it did not). */
  stopReason: GoogleStopReason | null;
  details: SyncDetail[];
};

/** Safe failure codes (the automatic sync records them; never a message or a Google body). */
export type GoogleSyncFailureCode = "not_connected" | "no_calendar" | "reconnect_required" | "rate_limited" | "temporary_error" | "unexpected";

export type GoogleSyncResult = { ok: true; summary: GoogleSyncSummary } | { ok: false; error: string; code: GoogleSyncFailureCode };

/** The safe code of an access failure. */
export function accessFailureCode(kind: AccessFailure): GoogleSyncFailureCode {
  if (kind === "not-connected") return "not_connected";
  if (kind === "revoked" || kind === "unauthorized" || kind === "unreadable") return "reconnect_required";
  return "temporary_error";
}

/** Why a sync stopped writing early. */
export type GoogleStopReason = "temporary_error" | "rate_limited" | "reconnect_required";

const MAX_DETAILS_PER_GROUP = 40;
const IMPORT_CHUNK = 500;

const FAILURE = {
  calendar: "Elige primero el calendario de Google que usará TRAZA.",
  local: "No se han podido leer tus datos de TRAZA. No se ha cambiado nada.",
  tooMany: "Tu calendario de Google tiene demasiados eventos en el periodo que se sincroniza. No se ha cambiado nada.",
};

function readFailure(kind: AccessFailure): string {
  return kind === "revoked" ? "Acceso retirado: vuelve a conectar Google Calendar. No se ha cambiado nada." : `${accessFailureMessage(kind)} No se ha cambiado nada.`;
}

function emptySummary(mode: SyncMode, calendarName: string, window: SyncWindow, otherCalendarLinks: number): GoogleSyncSummary {
  const counts = () => ({ create: 0, update: 0, unchanged: 0 });
  return {
    mode,
    calendarName,
    window,
    events: counts(),
    tasks: counts(),
    removals: 0,
    imports: counts(),
    skipped: 0,
    missingInGoogle: 0,
    otherCalendarLinks,
    failed: 0,
    incomplete: false,
    stopReason: null,
    details: [],
  };
}

function addDetail(summary: GoogleSyncSummary, detail: SyncDetail) {
  if (summary.details.filter((existing) => existing.group === detail.group).length < MAX_DETAILS_PER_GROUP) summary.details.push(detail);
}

/** Counts one action as done (preview: as planned). */
function tally(summary: GoogleSyncSummary, action: PlanAction) {
  switch (action.kind) {
    case "createGoogleEvent":
    case "updateGoogleEvent": {
      const verb = action.kind === "createGoogleEvent" ? "create" : "update";
      const isTask = action.item.itemType === "task";
      (isTask ? summary.tasks : summary.events)[verb]++;
      addDetail(summary, { group: `${isTask ? "task" : "event"}-${verb}`, title: action.item.title, date: action.item.date });
      return;
    }
    case "deleteGoogleEvent":
      summary.removals++;
      if (action.title) addDetail(summary, { group: "removal", title: action.title, date: null });
      return;
    case "importGoogleEvent":
    case "updateGoogleMirror": {
      const verb = action.kind === "importGoogleEvent" ? "create" : "update";
      summary.imports[verb]++;
      addDetail(summary, { group: `import-${verb}`, title: action.write.title, date: action.write.event_date });
      return;
    }
    case "unchanged":
      if (action.side === "import") summary.imports.unchanged++;
      else (action.item.itemType === "task" ? summary.tasks : summary.events).unchanged++;
      return;
    case "skipped":
      summary.skipped++;
      return;
    case "warning":
      summary.missingInGoogle++;
      addDetail(summary, { group: "missing", title: action.title, date: action.date });
  }
}

/**
 * Vista previa (mode "preview") or Sincronizar (mode "sync"). Both read the same things and run
 * the same planner; only "sync" then carries the plan out.
 */
export async function runGoogleSync(deps: GoogleSyncDeps, mode: SyncMode): Promise<GoogleSyncResult> {
  const fail = (kind: AccessFailure): GoogleSyncResult => ({ ok: false, error: readFailure(kind), code: accessFailureCode(kind) });
  const metadata = await deps.connection.store.loadMetadata();
  if (!metadata.ok) return fail("storage");
  if (!metadata.metadata) return fail("not-connected");
  if (metadata.metadata.status !== "connected") return fail("revoked");
  const { selectedCalendarId: calendarId, selectedCalendarName: calendarName } = metadata.metadata;
  if (!calendarId || !calendarName) return { ok: false, error: FAILURE.calendar, code: "no_calendar" };

  const access = await getAccessToken(deps.connection);
  if (!access.ok) return fail(access.kind);
  let accessToken = access.accessToken;
  let refreshed = false;

  const window = syncWindow(deps.today);
  const range = listingRange(window);
  let listed = await listEvents(accessToken, calendarId, range, deps.connection.fetch);
  if (!listed.ok && listed.kind === "unauthorized") {
    refreshed = true;
    const retry = await getAccessToken(deps.connection, { forceRefresh: true });
    if (!retry.ok) return fail(retry.kind);
    accessToken = retry.accessToken;
    listed = await listEvents(accessToken, calendarId, range, deps.connection.fetch);
  }
  if (!listed.ok) {
    if (listed.kind === "too-many") return { ok: false, error: FAILURE.tooMany, code: "unexpected" };
    if (listed.kind === "rate-limited") return { ok: false, error: readFailure("unavailable"), code: "rate_limited" };
    if (listed.kind === "invalid-response") return { ok: false, error: readFailure("unavailable"), code: "unexpected" };
    return fail(listed.kind === "unauthorized" || listed.kind === "revoked" ? "unauthorized" : "unavailable");
  }

  const { store } = deps;
  const links = await store.loadLinks();
  if (!links) return { ok: false, error: FAILURE.local, code: "temporary_error" };
  const linkedTasks = links.flatMap((link) => (link.task_id ? [link.task_id] : []));
  const linkedEvents = links.flatMap((link) => (link.calendar_event_id ? [link.calendar_event_id] : []));
  const [events, tasks, imported, projectNames] = await Promise.all([
    store.loadEvents(window, linkedEvents),
    store.loadTasks(window, linkedTasks),
    store.loadImported(),
    store.loadProjectNames(),
  ]);
  if (!events || !tasks || !imported || !projectNames) return { ok: false, error: FAILURE.local, code: "temporary_error" };

  const plan = planSync({ calendarId, window, events, tasks, imported, links, projectNames, google: listed.events });
  const summary = emptySummary(mode, calendarName, window, plan.otherCalendarLinks);
  summary.skipped += listed.unreadable;

  if (mode === "preview") {
    for (const action of plan.actions) tally(summary, action);
    return { ok: true, summary };
  }

  // ----- Sync: carry the plan out -----
  const selectedId: string = calendarId;
  let stopped = false;
  const fetchFn = deps.connection.fetch;
  const newEventId = deps.newEventId ?? (() => randomBytes(20).toString("hex"));

  /** One Google write, retried once with a refreshed token if Google rejects the current one. */
  async function google(write: (token: string) => Promise<WriteResult>): Promise<WriteResult> {
    let result = await write(accessToken);
    if (!result.ok && result.kind === "unauthorized" && !refreshed) {
      refreshed = true;
      const retry = await getAccessToken(deps.connection, { forceRefresh: true });
      if (!retry.ok) {
        stopped = true;
        summary.stopReason ??= accessFailureCode(retry.kind) === "reconnect_required" ? "reconnect_required" : "temporary_error";
        return { ok: false, kind: "unauthorized" };
      }
      accessToken = retry.accessToken;
      result = await write(accessToken);
    }
    // Lost access, rate-limited or Google unavailable: stop writing for this run.
    if (!result.ok && (result.kind === "unauthorized" || result.kind === "unavailable" || result.kind === "revoked" || result.kind === "rate-limited")) {
      stopped = true;
      summary.stopReason ??= result.kind === "rate-limited" ? "rate_limited" : result.kind === "unavailable" ? "temporary_error" : "reconnect_required";
    }
    return result;
  }

  async function writeMirror(eventId: string, body: GoogleEventBody, operation: "create" | "update", ownId: string): Promise<string | null> {
    if (operation === "create") {
      let result = await google((token) => insertEvent(token, selectedId, eventId, body, fetchFn));
      // The id exists already (an earlier, unrecorded create): rewrite that event instead.
      if (!result.ok && result.kind === "conflict") result = await google((token) => updateEvent(token, selectedId, eventId, body, fetchFn));
      return result.ok ? eventId : null;
    }
    const result = await google((token) => updateEvent(token, selectedId, eventId, body, fetchFn));
    if (result.ok) return eventId;
    if (result.kind !== "not-found" || stopped) return null;
    // Gone for good in Google: TRAZA owns the item, so its mirror is created again.
    for (const candidate of eventId === ownId ? [newEventId()] : [ownId, newEventId()]) {
      const created = await google((token) => insertEvent(token, selectedId, candidate, body, fetchFn));
      if (created.ok) return candidate;
      if (created.kind !== "conflict") return null;
    }
    return null;
  }

  // 1. Google → TRAZA (database only; independent of the Google writes below).
  const writes = plan.actions.flatMap((action) => (action.kind === "importGoogleEvent" || action.kind === "updateGoogleMirror" ? [action.write] : []));
  for (let i = 0; i < writes.length; i += IMPORT_CHUNK) {
    const chunk = writes.slice(i, i + IMPORT_CHUNK);
    const outcomes = await store.upsertImported(calendarId, chunk);
    if (!outcomes) {
      summary.failed += chunk.length;
      continue;
    }
    const byId = new Map(chunk.map((write) => [write.event_id, write]));
    for (const { event_id, outcome } of outcomes) {
      const write = byId.get(event_id);
      if (!write) continue;
      if (outcome === "created") tally(summary, { kind: "importGoogleEvent", write });
      else if (outcome === "updated") tally(summary, { kind: "updateGoogleMirror", write });
      else if (outcome === "unchanged") summary.imports.unchanged++;
      else summary.skipped++;
    }
  }

  // 2. TRAZA → Google, in plan order.
  for (const action of plan.actions) {
    if (action.kind === "importGoogleEvent" || action.kind === "updateGoogleMirror") continue;
    if (action.kind === "skipped" || action.kind === "warning" || (action.kind === "unchanged" && action.side === "import")) {
      tally(summary, action);
      continue;
    }
    if (action.kind === "unchanged") {
      // No Google call: only record an adopted mirror or a changed hash.
      if (action.refreshLink) {
        const recorded = action.linkId
          ? await store.updateLink(action.linkId, { hash: action.hash })
          : (await store.insertLink({ calendarId, eventId: action.eventId, itemType: action.item.itemType, localId: action.item.localId, hash: action.hash })) !== "error";
        if (!recorded) summary.failed++;
      }
      tally(summary, action);
      continue;
    }
    if (stopped) {
      summary.incomplete = true;
      continue;
    }

    if (action.kind === "deleteGoogleEvent") {
      const deleted = await google((token) => deleteEvent(token, selectedId, action.eventId, fetchFn));
      // The link is removed only once Google confirmed; otherwise the tombstone stays for next time.
      if (deleted.ok && (await store.deleteLink(action.linkId))) tally(summary, action);
      else summary.failed++;
      continue;
    }

    const ownId = mirrorEventId(action.item.itemType, action.item.localId, calendarId);
    const writtenId = await writeMirror(action.eventId, action.body, action.kind === "createGoogleEvent" ? "create" : "update", ownId);
    if (!writtenId) {
      summary.failed++;
      continue;
    }
    const linkId = action.kind === "updateGoogleEvent" ? action.linkId : null;
    const recorded = linkId
      ? await store.updateLink(linkId, { hash: action.hash, ...(writtenId !== action.eventId ? { eventId: writtenId } : {}) })
      : (await store.insertLink({ calendarId, eventId: writtenId, itemType: action.item.itemType, localId: action.item.localId, hash: action.hash })) !== "error";
    // An unrecorded mirror is harmless: its deterministic id makes the next sync adopt it.
    if (recorded) tally(summary, action);
    else summary.failed++;
  }
  if (stopped) summary.incomplete = true;
  return { ok: true, summary };
}
