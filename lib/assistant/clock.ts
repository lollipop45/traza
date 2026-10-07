import { APP_TIME_ZONE, addDays, parseISODate } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";

// The assistant's notion of "now": always the Atlantic/Canary wall clock, whatever the server's own
// time zone (a UTC host at 23:30 is already "mañana" in summer here). Relative expressions
// ("mañana", "el jueves", "la semana que viene") are resolved by the model against this, and the
// table of upcoming days removes any guessing about weekdays.

export type AssistantNow = { date: ISODate; time: string; weekday: string };

const clockFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const weekdayFormat = new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", weekday: "long" });

export function weekdayOf(date: ISODate): string {
  return weekdayFormat.format(parseISODate(date));
}

export function canaryNow(now: Date): AssistantNow {
  const parts = Object.fromEntries(clockFormat.formatToParts(now).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, weekday: weekdayOf(date) };
}

/** Today and the next `count - 1` days, with their weekday names. */
export function upcomingDays(today: ISODate, count = 15): { date: ISODate; weekday: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(today, i);
    return { date, weekday: weekdayOf(date) };
  });
}

/** Monday–Sunday of the week containing `date` (ISO week, as in Spain). */
export function weekOf(date: ISODate): { from: ISODate; to: ISODate } {
  const offset = (parseISODate(date).getUTCDay() + 6) % 7;
  const from = addDays(date, -offset);
  return { from, to: addDays(from, 6) };
}

/** Local time of a timestamp in Atlantic/Canary: "10:42". */
export function canaryTime(timestamp: string): string {
  const parts = Object.fromEntries(clockFormat.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

/** Calendar date of a timestamp in Atlantic/Canary. */
export function canaryDate(timestamp: string): ISODate {
  const parts = Object.fromEntries(clockFormat.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
