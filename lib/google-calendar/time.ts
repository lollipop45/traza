import { APP_TIME_ZONE, addDays } from "@/lib/calendar/dates";
import type { ISODate, TimeOfDay } from "@/lib/calendar/types";

// Time-zone rules of the Google Calendar sync. TRAZA stores local wall-clock values for
// Atlantic/Canary (calendar_events.event_date + start_time/end_time, tasks.due_date); Google works
// with instants (RFC 3339 with an offset) or plain dates for all-day events.
//   Google → TRAZA: an instant becomes the Atlantic/Canary date and time it shows there.
//   TRAZA → Google: a wall-clock time is sent as a local dateTime plus timeZone "Atlantic/Canary",
//                   so Google applies the right offset on each side of a daylight-saving change.
//   All-day dates are plain dates on both sides: never converted, never shifted.

/** The bounded sync window, in Atlantic/Canary calendar days. */
export const SYNC_PAST_DAYS = 30;
export const SYNC_FUTURE_DAYS = 365;

export type SyncWindow = { from: ISODate; to: ISODate };

/** [today − 30 days, today + 365 days], inclusive. */
export function syncWindow(today: ISODate): SyncWindow {
  return { from: addDays(today, -SYNC_PAST_DAYS), to: addDays(today, SYNC_FUTURE_DAYS) };
}

export function inWindow(date: ISODate, window: SyncWindow): boolean {
  return date >= window.from && date <= window.to;
}

/**
 * The instants to ask Google for: a day of margin on each side (offsets are at most ±14 h), so every
 * event that falls on a window day in Atlantic/Canary is listed. Results are filtered by local date.
 */
export function listingRange(window: SyncWindow): { timeMin: string; timeMax: string } {
  return { timeMin: `${addDays(window.from, -1)}T00:00:00Z`, timeMax: `${addDays(window.to, 2)}T00:00:00Z` };
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d{1,9})?)?$/;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export type WallClock = { date: ISODate; time: TimeOfDay };

/** The date and "HH:MM" an instant shows in `timeZone` (seconds dropped). */
export function wallClockAt(instant: number, timeZone: string = APP_TIME_ZONE): WallClock {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Offset of `timeZone` from UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - (instant - (instant % 1000));
}

/**
 * The instant at which `timeZone` shows a wall-clock date and time. In the spring-forward gap (a
 * time that does not exist locally) it resolves to the later offset, like Google and most calendars.
 */
export function instantOfWallClock(date: ISODate, time: TimeOfDay, timeZone: string = APP_TIME_ZONE): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetAt(asUtc, timeZone);
  const shown = wallClockAt(first, timeZone);
  if (shown.date === date && shown.time === time.slice(0, 5)) return first;
  // Near a change the first guess used the other side's offset; the second one settles it.
  return asUtc - offsetAt(first, timeZone);
}

/** Parses an RFC 3339 dateTime from Google. Without an offset it is read in `timeZone` (if valid). */
export function parseGoogleDateTime(value: unknown, timeZone: string | null): number | null {
  if (typeof value !== "string") return null;
  if (RFC3339.test(value)) {
    const instant = Date.parse(value);
    return Number.isFinite(instant) ? instant : null;
  }
  const local = LOCAL_DATE_TIME.exec(value);
  if (!local || !timeZone || !isTimeZone(timeZone)) return null;
  return instantOfWallClock(local[1], local[2], timeZone);
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Google's local dateTime for a TRAZA wall-clock value: "2026-10-12T09:00:00". */
export function localDateTime(date: ISODate, time: TimeOfDay): string {
  return `${date}T${time.slice(0, 5)}:00`;
}
