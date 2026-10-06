import type { Tables } from "@/lib/supabase/database.types";

/** ISO calendar date, e.g. "2026-10-05". */
export type ISODate = string;

/** 24h local time, e.g. "09:30". */
export type TimeOfDay = string;

/** A row of `public.calendar_events`, exactly as generated from the database. */
export type CalendarEventRow = Tables<"calendar_events">;

/**
 * Columns the calendar reads: a deliberate projection of `CalendarEventRow`. Times come back from
 * Postgres as "HH:MM:SS" local wall-clock values (no time zone involved).
 */
export type CalendarEventRecord = Pick<
  CalendarEventRow,
  "id" | "title" | "description" | "event_date" | "start_time" | "end_time" | "all_day" | "location" | "project_id" | "source"
>;
export const CALENDAR_EVENT_COLUMNS =
  "id, title, description, event_date, start_time, end_time, all_day, location, project_id, source";

/**
 * Imported from the user's selected Google calendar (manual Google sync). Google owns its title,
 * date, times, location and description; TRAZA only lets the user choose its project, and does not
 * delete it (it is deleted in Google Calendar).
 */
export const GOOGLE_EVENT_SOURCE = "google-calendar";
export const GOOGLE_EVENT_DELETE_MESSAGE = "Los eventos de Google se eliminan en Google Calendar.";

export function isGoogleEvent(event: Pick<CalendarEventRow, "source">): boolean {
  return event.source === GOOGLE_EVENT_SOURCE;
}

/** Mirror the check constraints in 20261005162926_create_calendar_events.sql. */
export const EVENT_TITLE_MAX_LENGTH = 200;
export const EVENT_LOCATION_MAX_LENGTH = 200;
export const EVENT_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * What the calendar renders: one model over two sources of truth. Events come from
 * `public.calendar_events`; task deadlines are tasks with a due date, read from `public.tasks`
 * (never copied into the events table). Each keeps its real database id.
 */
export type CalendarItem = CalendarEventItem | TaskDeadlineItem;

export type CalendarEventItem = {
  itemType: "event";
  /** calendar_events.id */
  id: string;
  title: string;
  date: ISODate;
  /** "HH:MM"; null for all-day events. */
  startTime: TimeOfDay | null;
  endTime: TimeOfDay | null;
  allDay: boolean;
  location: string | null;
  projectName: string | null;
  source: string;
};

export type TaskDeadlineItem = {
  itemType: "task-deadline";
  /** tasks.id */
  id: string;
  title: string;
  date: ISODate;
  projectName: string | null;
  done: boolean;
  /** Imported from Campus Virtual (tasks.source = 'canvas'). */
  campus: boolean;
};
