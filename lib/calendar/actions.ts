"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
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

export async function updateEvent(eventId: string, formData: FormData): Promise<EventMutationResult> {
  await requireUser();
  const failed: EventMutationResult = { ok: false, error: "No se ha podido actualizar el evento." };
  if (!isEventId(eventId)) return failed;

  const parsed = parseEventDetails(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();
  const { data, error } = await supabase.from("calendar_events").update(parsed.value).eq("id", eventId).select("id");
  // Zero rows: the event does not exist or belongs to someone else (filtered out by RLS).
  if (error || data.length === 0) return failed;

  revalidateEventViews();
  redirect(dayHref(parsed.value.event_date));
}

export async function deleteEvent(eventId: string): Promise<EventMutationResult> {
  await requireUser();
  const failed: EventMutationResult = { ok: false, error: "No se ha podido eliminar el evento." };
  if (!isEventId(eventId)) return failed;

  const supabase = await createClient();
  const { data, error } = await supabase.from("calendar_events").delete().eq("id", eventId).select("event_date");
  if (error || data.length === 0) return failed;

  revalidateEventViews();
  redirect(dayHref(data[0].event_date));
}
