"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { parseProjectId } from "@/lib/projects/validation";
import { createClient } from "@/lib/supabase/server";
import { formField } from "@/lib/validation";
import { GOOGLE_EVENT_DELETE_MESSAGE, GOOGLE_EVENT_SOURCE } from "./types";
import { isEventId, parseEventDetails } from "./validation";
import { calendarHref } from "./view";

// Every mutation: verifies the session, validates its input here on the server, and relies on RLS
// for ownership. None accepts a user_id, source, external_id or timestamps: those columns are not
// writable by `authenticated` (column-scoped grants), so manual events always get source = manual.
// A project_id must belong to the same user (calendar_events_project_owner_fkey). Errors become
// fixed Spanish messages and are never logged.

const CALENDAR_PATH = "/calendar";
const HOME_PATH = "/";

export type EventMutationResult = { ok: true } | { ok: false; error: string };

function revalidateEventViews() {
  revalidatePath(CALENDAR_PATH);
  // Home lists today's events.
  revalidatePath(HOME_PATH);
}

/** The calendar on the event's day, with no panel open. */
function dayHref(date: string): string {
  return calendarHref({ month: date, selected: date });
}

export async function createEvent(formData: FormData): Promise<EventMutationResult> {
  await requireUser();

  const parsed = parseEventDetails(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();
  const { error } = await supabase.from("calendar_events").insert(parsed.value);
  if (error) return { ok: false, error: "No se ha podido crear el evento." };

  revalidateEventViews();
  redirect(dayHref(parsed.value.event_date));
}

/** The event's stored source, or null when it does not exist / is not the caller's (RLS). */
async function eventSource(supabase: Awaited<ReturnType<typeof createClient>>, eventId: string): Promise<string | null> {
  const { data, error } = await supabase.from("calendar_events").select("source").eq("id", eventId).maybeSingle();
  return error || !data ? null : data.source;
}

export async function updateEvent(eventId: string, formData: FormData): Promise<EventMutationResult> {
  await requireUser();
  const failed: EventMutationResult = { ok: false, error: "No se ha podido actualizar el evento." };
  if (!isEventId(eventId)) return failed;

  const supabase = await createClient();
  const source = await eventSource(supabase, eventId);
  if (!source) return failed;

  // Google-origin events: Google owns the synced fields (the next sync would overwrite them), so
  // only the TRAZA project can change here.
  if (source === GOOGLE_EVENT_SOURCE) {
    if (!formData.has("project_id")) return failed;
    const projectId = parseProjectId(formField(formData, "project_id"));
    if (!projectId.ok) return { ok: false, error: projectId.error };
    const { data, error } = await supabase
      .from("calendar_events")
      .update({ project_id: projectId.value })
      .eq("id", eventId)
      .eq("source", GOOGLE_EVENT_SOURCE)
      .select("event_date");
    if (error || data.length === 0) return failed;
    revalidateEventViews();
    redirect(dayHref(data[0].event_date));
  }

  const parsed = parseEventDetails(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Filtering on the source read above means a concurrent change of kind can never widen the edit.
  const { data, error } = await supabase.from("calendar_events").update(parsed.value).eq("id", eventId).eq("source", source).select("id");
  // Zero rows: the event does not exist or belongs to someone else (filtered out by RLS).
  if (error || data.length === 0) return failed;

  revalidateEventViews();
  redirect(dayHref(parsed.value.event_date));
}

/**
 * Deletes a TRAZA event. If it has a Google mirror, the database turns that link into a tombstone
 * (google_calendar_item_links, ON DELETE SET NULL) and the next manual sync removes the mirror from
 * Google. Google-origin events are not deleted here: Google owns them (and would bring them back).
 */
export async function deleteEvent(eventId: string): Promise<EventMutationResult> {
  await requireUser();
  const failed: EventMutationResult = { ok: false, error: "No se ha podido eliminar el evento." };
  if (!isEventId(eventId)) return failed;

  const supabase = await createClient();
  const source = await eventSource(supabase, eventId);
  if (!source) return failed;
  if (source === GOOGLE_EVENT_SOURCE) return { ok: false, error: GOOGLE_EVENT_DELETE_MESSAGE };

  const { data, error } = await supabase.from("calendar_events").delete().eq("id", eventId).neq("source", GOOGLE_EVENT_SOURCE).select("event_date");
  if (error || data.length === 0) return failed;

  revalidateEventViews();
  redirect(dayHref(data[0].event_date));
}
