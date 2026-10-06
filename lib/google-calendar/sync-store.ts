import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { SyncStore } from "./sync";
import { GOOGLE_EVENT_SOURCE, ITEM_LINK_COLUMNS, LOCAL_EVENT_COLUMNS, LOCAL_TASK_COLUMNS, type ItemLink, type LocalEvent, type LocalTask } from "./sync-model";

// Supabase access for the manual Google Calendar sync, as the signed-in user (publishable key + the
// user's session; RLS limits every statement to their own rows; no service role). Server-only;
// callers must have verified the session. Errors are not logged: they can echo data.
//
// Links are written with ordinary owner-scoped table privileges (nothing in them is secret; the
// composite foreign keys keep each link inside its owner's data). Google-origin events are written
// only through sync_google_calendar_events(), because calendar_events.source/external_id are not
// writable by `authenticated`.

const PAGE = 1000;
const ID_CHUNK = 200;

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Every row of a query, page by page (the Data API caps a single response). */
async function all<T>(page: (from: number, to: number) => Page<T>): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error || !data) return null;
    rows.push(...data);
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

export function createSyncStore(userId: string): SyncStore {
  return {
    async loadLinks() {
      const supabase = await createClient();
      return all<ItemLink>((from, to) =>
        supabase.from("google_calendar_item_links").select(ITEM_LINK_COLUMNS).eq("user_id", userId).order("id").range(from, to),
      );
    },

    async loadEvents(window, ids) {
      const supabase = await createClient();
      const inWindow = all<LocalEvent>((from, to) =>
        supabase
          .from("calendar_events")
          .select(LOCAL_EVENT_COLUMNS)
          .eq("user_id", userId)
          .neq("source", GOOGLE_EVENT_SOURCE)
          .gte("event_date", window.from)
          .lte("event_date", window.to)
          .order("id")
          .range(from, to),
      );
      const linked = chunks(ids).map(async (chunk) => {
        const { data, error } = await supabase.from("calendar_events").select(LOCAL_EVENT_COLUMNS).eq("user_id", userId).neq("source", GOOGLE_EVENT_SOURCE).in("id", chunk);
        return error ? null : data;
      });
      const lists = await Promise.all([inWindow, ...linked]);
      return lists.some((list) => list === null) ? null : mergeById(lists as LocalEvent[][]);
    },

    async loadTasks(window, ids) {
      const supabase = await createClient();
      const inWindow = all<LocalTask>((from, to) =>
        supabase
          .from("tasks")
          .select(LOCAL_TASK_COLUMNS)
          .eq("user_id", userId)
          .gte("due_date", window.from)
          .lte("due_date", window.to)
          .order("id")
          .range(from, to),
      );
      const linked = chunks(ids).map(async (chunk) => {
        const { data, error } = await supabase.from("tasks").select(LOCAL_TASK_COLUMNS).eq("user_id", userId).in("id", chunk);
        return error ? null : data;
      });
      const lists = await Promise.all([inWindow, ...linked]);
      return lists.some((list) => list === null) ? null : mergeById(lists as LocalTask[][]);
    },

    async loadImported() {
      const supabase = await createClient();
      return all<LocalEvent>((from, to) =>
        supabase.from("calendar_events").select(LOCAL_EVENT_COLUMNS).eq("user_id", userId).eq("source", GOOGLE_EVENT_SOURCE).order("id").range(from, to),
      );
    },

    async loadProjectNames() {
      const supabase = await createClient();
      const rows = await all<{ id: string; name: string }>((from, to) => supabase.from("projects").select("id, name").eq("user_id", userId).order("id").range(from, to));
      return rows ? new Map(rows.map((row) => [row.id, row.name])) : null;
    },

    async insertLink({ calendarId, eventId, itemType, localId, hash }) {
      const supabase = await createClient();
      const { error } = await supabase.from("google_calendar_item_links").insert({
        google_calendar_id: calendarId,
        google_event_id: eventId,
        item_type: itemType,
        task_id: itemType === "task" ? localId : null,
        calendar_event_id: itemType === "calendar_event" ? localId : null,
        content_hash: hash,
        last_synced_at: new Date().toISOString(),
      });
      if (!error) return "ok";
      // Another sync recorded the same mirror first (unique keys): nothing to add.
      return error.code === "23505" ? "exists" : "error";
    },

    async updateLink(linkId, { eventId, hash }) {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("google_calendar_item_links")
        .update({ content_hash: hash, last_synced_at: new Date().toISOString(), ...(eventId ? { google_event_id: eventId } : {}) })
        .eq("id", linkId)
        .eq("user_id", userId)
        .select("id");
      return !error && data.length === 1;
    },

    async deleteLink(linkId) {
      const supabase = await createClient();
      const { error } = await supabase.from("google_calendar_item_links").delete().eq("id", linkId).eq("user_id", userId);
      return !error;
    },

    async upsertImported(calendarId, writes) {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("sync_google_calendar_events", { p_calendar_id: calendarId, p_events: writes });
      if (error || !Array.isArray(data)) return null;
      return data;
    },
  };
}
