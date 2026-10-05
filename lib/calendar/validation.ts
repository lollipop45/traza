import { parseProjectId } from "@/lib/projects/validation";
import { charLength, formField, isUuid, type Parsed } from "@/lib/validation";
import { isValidISODate } from "./dates";
import {
  EVENT_DESCRIPTION_MAX_LENGTH,
  EVENT_LOCATION_MAX_LENGTH,
  EVENT_TITLE_MAX_LENGTH,
  type ISODate,
  type TimeOfDay,
} from "./types";

// Server-side parsing of untrusted event form input. Only the editable columns are read; id,
// user_id, source, external_id and timestamps are never taken from the browser.

/** Editable event fields, named like their `public.calendar_events` columns. */
export type EventDetails = {
  title: string;
  description: string | null;
  event_date: ISODate;
  start_time: TimeOfDay | null;
  end_time: TimeOfDay | null;
  all_day: boolean;
  location: string | null;
  /** Omitted when the form has no project field: the stored value is then left unchanged. */
  project_id?: string | null;
};

export function isEventId(value: unknown): value is string {
  return isUuid(value);
}

export function parseEventTitle(raw: string): Parsed<string> {
  const title = raw.trim();
  if (!title) return { ok: false, error: "Escribe el título del evento." };
  if (charLength(title) > EVENT_TITLE_MAX_LENGTH) {
    return { ok: false, error: `El título no puede superar los ${EVENT_TITLE_MAX_LENGTH} caracteres.` };
  }
  return { ok: true, value: title };
}

/** Required: a real calendar date within the range the app supports. */
export function parseEventDate(raw: string): Parsed<ISODate> {
  const value = raw.trim();
  if (!isValidISODate(value) || value < "2000-01-01" || value > "2100-12-31") {
    return { ok: false, error: "La fecha no es válida." };
  }
  return { ok: true, value };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "" → null; otherwise strict 24h "HH:mm" (what <input type="time"> submits). */
export function parseTime(raw: string): Parsed<TimeOfDay | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return TIME.test(value) ? { ok: true, value } : { ok: false, error: "La hora no es válida." };
}

/**
 * All-day events carry no times (any submitted times are ignored). Timed events need a start; an
 * end is optional but cannot be earlier than the start (same day; no overnight events yet).
 */
export function parseEventTimes(
  allDay: boolean,
  rawStart: string,
  rawEnd: string,
): Parsed<{ all_day: boolean; start_time: TimeOfDay | null; end_time: TimeOfDay | null }> {
  if (allDay) return { ok: true, value: { all_day: true, start_time: null, end_time: null } };
  const start = parseTime(rawStart);
  if (!start.ok) return start;
  const end = parseTime(rawEnd);
  if (!end.ok) return end;
  if (!start.value) return { ok: false, error: "Indica la hora de inicio o marca «Todo el día»." };
  if (end.value && end.value < start.value) {
    return { ok: false, error: "La hora de fin no puede ser anterior a la de inicio." };
  }
  return { ok: true, value: { all_day: false, start_time: start.value, end_time: end.value } };
}

function parseOptionalText(raw: string, max: number, error: string): Parsed<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return charLength(value) > max ? { ok: false, error } : { ok: true, value };
}

export function parseLocation(raw: string): Parsed<string | null> {
  return parseOptionalText(raw, EVENT_LOCATION_MAX_LENGTH, `La ubicación no puede superar los ${EVENT_LOCATION_MAX_LENGTH} caracteres.`);
}

export function parseEventDescription(raw: string): Parsed<string | null> {
  return parseOptionalText(
    raw,
    EVENT_DESCRIPTION_MAX_LENGTH,
    `La descripción no puede superar los ${EVENT_DESCRIPTION_MAX_LENGTH} caracteres.`,
  );
}

/** Reads an event form. The all-day checkbox submits `all_day=on` only when checked. */
export function parseEventDetails(formData: FormData): Parsed<EventDetails> {
  const title = parseEventTitle(formField(formData, "title"));
  if (!title.ok) return title;
  const date = parseEventDate(formField(formData, "event_date"));
  if (!date.ok) return date;
  const times = parseEventTimes(formData.has("all_day"), formField(formData, "start_time"), formField(formData, "end_time"));
  if (!times.ok) return times;
  const location = parseLocation(formField(formData, "location"));
  if (!location.ok) return location;
  const description = parseEventDescription(formField(formData, "description"));
  if (!description.ok) return description;

  const details: EventDetails = {
    title: title.value,
    description: description.value,
    event_date: date.value,
    ...times.value,
    location: location.value,
  };
  if (formData.has("project_id")) {
    const projectId = parseProjectId(formField(formData, "project_id"));
    if (!projectId.ok) return projectId;
    details.project_id = projectId.value;
  }
  return { ok: true, value: details };
}
