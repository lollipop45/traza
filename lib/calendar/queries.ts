import "server-only";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { CALENDAR_EVENT_COLUMNS, type CalendarEventRecord, type ISODate } from "./types";

// Server-side reads only. RLS already restricts rows to the owner; the explicit user_id filter
// matches the (user_id, event_date) index and documents intent. Errors are not logged.

export type CalendarEventsResult = { ok: true; events: CalendarEventRecord[] } | { ok: false };

/** The signed-in user's events between two local dates, inclusive, in date/time order. */
export async function getEventsBetween(from: ISODate, to: ISODate): Promise<CalendarEventsResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("calendar_events")
    .select(CALENDAR_EVENT_COLUMNS)
    .eq("user_id", user.id)
    .gte("event_date", from)
    .lte("event_date", to)
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true });

  if (error) return { ok: false };
  return { ok: true, events: data };
}
