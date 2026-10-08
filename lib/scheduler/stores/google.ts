import "server-only";
import { currentISODate } from "@/lib/calendar/dates";
import type { LeasedGoogleSyncDeps, GoogleSyncClaim, GoogleSyncRecord, GoogleSyncStateStore } from "@/lib/google-calendar/auto-sync";
import type { ConnectionMetadata, ConnectionStore, StoredCredentials } from "@/lib/google-calendar/connection";
import { readGoogleCalendarConfig } from "@/lib/google-calendar/env";
import { withGoogleRetries } from "@/lib/google-calendar/http";
import { CONNECTION_METADATA_COLUMNS } from "@/lib/google-calendar/store";
import type { SyncStore } from "@/lib/google-calendar/sync";
import { GOOGLE_EVENT_SOURCE, ITEM_LINK_COLUMNS, LOCAL_EVENT_COLUMNS, LOCAL_TASK_COLUMNS, type ItemLink, type LocalEvent, type LocalTask } from "@/lib/google-calendar/sync-model";
import { GOOGLE_SYNC_DEADLINE_MS, type GoogleSyncTrigger } from "@/lib/google-calendar/sync-policy";
import type { ScheduledScope } from "../scope";

// Scheduled counterpart of lib/google-calendar/{store,sync-store,sync-state-store,sync-deps}.ts for
// ONE target user, through a ScheduledScope. The reconciliation, token refresh / decryption
// (server-only, lib/google-calendar/connection.ts) and loop protection are the existing engine's.
// Every TRAZA row read or written belongs to the scope's user; the encrypted credentials come only
// from scheduler_get_google_calendar_credentials for that user and go straight to the connection
// module, which decrypts them with that same user id as context (so another user's ciphertext could
// not even be decrypted). Nothing here returns or logs a token.
//
// Only what a sync needs is implemented: connecting, choosing a calendar and disconnecting stay
// interactive-only (they refuse here).

const TABLE = "google_calendar_connections";

type ConnectionRow = { status: string; google_account_email: string | null; selected_calendar_id: string | null; selected_calendar_name: string | null };
const PAGE = 1000;
const ID_CHUNK = 200;

type Page = PromiseLike<{ data: unknown[] | null; error: unknown }>;

/** Every row of a query, page by page (same paging as the interactive store). */
async function all<T>(page: (from: number, to: number) => Page): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error || !data) return null;
    rows.push(...(data as T[]));
    if (data.length < PAGE) return rows;
  }
}

function chunks(ids: string[]): string[][] {
  const unique = [...new Set(ids)];
  const result: string[][] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) result.push(unique.slice(i, i + ID_CHUNK));
  return result;
}

function mergeById<T extends { id: string }>(lists: T[][]): T[] {
  return [...new Map(lists.flat().map((row) => [row.id, row])).values()];
}

function createScheduledConnectionStore(scope: ScheduledScope): ConnectionStore {
  const refuse = async () => false;
  return {
    async loadMetadata() {
      const { data, error } = await scope.select<ConnectionRow>(TABLE, CONNECTION_METADATA_COLUMNS).maybeSingle();
      if (error) return { ok: false };
      const row = data;
      const metadata: ConnectionMetadata | null = row
        ? { status: row.status, accountEmail: row.google_account_email, selectedCalendarId: row.selected_calendar_id, selectedCalendarName: row.selected_calendar_name }
        : null;
      return { ok: true, metadata };
    },

    async loadCredentials() {
      const { data, error } = await scope.rpc("scheduler_get_google_calendar_credentials", {});
      if (error || !Array.isArray(data)) return { ok: false };
      const row = data[0];
      const credentials: StoredCredentials | null =
        row && row.refresh_token_ciphertext
          ? { refreshCiphertext: row.refresh_token_ciphertext, accessCiphertext: row.access_token_ciphertext, accessExpiresAt: row.access_token_expires_at }
          : null;
      return { ok: true, credentials };
    },

    async saveAccessToken({ accessCiphertext, accessExpiresAt, refreshCiphertext }) {
      const { error } = await scope
        .update(TABLE, {
          access_token_ciphertext: accessCiphertext,
          access_token_expires_at: accessExpiresAt,
          ...(refreshCiphertext ? { refresh_token_ciphertext: refreshCiphertext } : {}),
        })
        .eq("status", "connected");
      return !error;
    },

    async markRevoked() {
      const { error } = await scope.update(TABLE, { status: "revoked", refresh_token_ciphertext: null, access_token_ciphertext: null, access_token_expires_at: null });
      return !error;
    },

    // Interactive-only (OAuth callback, calendar choice, disconnect): never done by the scheduler.
    saveConnection: refuse,
    saveSelectedCalendar: refuse,
    deleteConnection: refuse,
  };
}

function createScheduledGoogleSyncStore(scope: ScheduledScope): SyncStore {
  return {
    loadLinks: () => all<ItemLink>((from, to) => scope.select<ItemLink>("google_calendar_item_links", ITEM_LINK_COLUMNS).order("id").range(from, to)),

    async loadEvents(window, ids) {
      const inWindow = all<LocalEvent>((from, to) =>
        scope.select<LocalEvent>("calendar_events", LOCAL_EVENT_COLUMNS).neq("source", GOOGLE_EVENT_SOURCE).gte("event_date", window.from).lte("event_date", window.to).order("id").range(from, to),
      );
      const linked = chunks(ids).map(async (chunk) => {
        const { data, error } = await scope.select<LocalEvent>("calendar_events", LOCAL_EVENT_COLUMNS).neq("source", GOOGLE_EVENT_SOURCE).in("id", chunk);
        return error ? null : data;
      });
      const lists = await Promise.all([inWindow, ...linked]);
      return lists.some((list) => list === null) ? null : mergeById(lists as LocalEvent[][]);
    },

    async loadTasks(window, ids) {
      const inWindow = all<LocalTask>((from, to) =>
        scope.select<LocalTask>("tasks", LOCAL_TASK_COLUMNS).gte("due_date", window.from).lte("due_date", window.to).order("id").range(from, to),
      );
      const linked = chunks(ids).map(async (chunk) => {
        const { data, error } = await scope.select<LocalTask>("tasks", LOCAL_TASK_COLUMNS).in("id", chunk);
        return error ? null : data;
      });
      const lists = await Promise.all([inWindow, ...linked]);
      return lists.some((list) => list === null) ? null : mergeById(lists as LocalTask[][]);
    },

    loadImported: () => all<LocalEvent>((from, to) => scope.select<LocalEvent>("calendar_events", LOCAL_EVENT_COLUMNS).eq("source", GOOGLE_EVENT_SOURCE).order("id").range(from, to)),

    async loadProjectNames() {
      const rows = await all<{ id: string; name: string }>((from, to) => scope.select<{ id: string; name: string }>("projects", "id, name").order("id").range(from, to));
      return rows ? new Map(rows.map((row) => [row.id, row.name])) : null;
    },

    async insertLink({ calendarId, eventId, itemType, localId, hash }) {
      // user_id is set by the scope; the composite foreign keys keep the item inside that user's data.
      const { error } = await scope.insert("google_calendar_item_links", {
        google_calendar_id: calendarId,
        google_event_id: eventId,
        item_type: itemType,
        task_id: itemType === "task" ? localId : null,
        calendar_event_id: itemType === "calendar_event" ? localId : null,
        content_hash: hash,
        last_synced_at: new Date().toISOString(),
      });
      if (!error) return "ok";
      return error.code === "23505" ? "exists" : "error";
    },

    async updateLink(linkId, { eventId, hash }) {
      const { data, error } = await scope
        .update("google_calendar_item_links", { content_hash: hash, last_synced_at: new Date().toISOString(), ...(eventId ? { google_event_id: eventId } : {}) })
        .eq("id", linkId)
        .select("id");
      return !error && Array.isArray(data) && data.length === 1;
    },

    async deleteLink(linkId) {
      const { error } = await scope.delete("google_calendar_item_links").eq("id", linkId);
      return !error;
    },

    async upsertImported(calendarId, writes) {
      const { data, error } = await scope.rpc("scheduler_sync_google_calendar_events", { p_calendar_id: calendarId, p_events: writes });
      return error || !Array.isArray(data) ? null : (data as { event_id: string; outcome: string }[]);
    },
  };
}

function createScheduledGoogleStateStore(scope: ScheduledScope): GoogleSyncStateStore {
  return {
    async claim(trigger: GoogleSyncTrigger, leaseSeconds: number): Promise<GoogleSyncClaim | null> {
      const { data, error } = await scope.rpc("scheduler_claim_google_calendar_sync", { p_trigger: trigger, p_lease_seconds: leaseSeconds });
      const row = Array.isArray(data) ? data[0] : null;
      if (error || !row || typeof row.claimed !== "boolean") return null;
      return {
        claimed: row.claimed,
        reason: String(row.reason),
        leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
        consecutiveFailures: typeof row.consecutive_failures === "number" ? row.consecutive_failures : 0,
      };
    },

    async finish(leaseToken: string, record: GoogleSyncRecord): Promise<boolean> {
      const { data, error } = await scope.rpc("scheduler_finish_google_calendar_sync", {
        p_lease_token: leaseToken,
        p_result: record.result,
        p_next_eligible_seconds: record.nextEligibleSeconds,
        p_created: record.created,
        p_updated: record.updated,
        p_imported: record.imported,
        p_deleted: record.deleted,
        p_unchanged: record.unchanged,
        p_failed: record.failed,
      });
      return !error && data === true;
    },
  };
}

/**
 * Pre-checks + lease + state + engine deps for runLeasedGoogleSync, for the scope's user, with the
 * "automatic" behaviour (cooldown applies; undecryptable credentials are never wiped).
 */
export function createScheduledGoogleDeps(scope: ScheduledScope, options: { deadline: number }): LeasedGoogleSyncDeps {
  const configResult = readGoogleCalendarConfig();
  const connection = createScheduledConnectionStore(scope);
  return {
    configured: configResult.ok,
    loadMetadata: () => connection.loadMetadata(),
    state: createScheduledGoogleStateStore(scope),
    createSync: () => {
      if (!configResult.ok) throw new Error("Google is not configured");
      const deadline = Math.min(Date.now() + GOOGLE_SYNC_DEADLINE_MS, options.deadline);
      return {
        connection: {
          config: configResult.config,
          userId: scope.userId,
          store: connection,
          fetch: withGoogleRetries((input, init) => fetch(input, init), { deadline }),
          now: Date.now,
          keepUnreadableCredentials: true,
        },
        store: createScheduledGoogleSyncStore(scope),
        today: currentISODate(),
      };
    },
    now: Date.now,
  };
}
