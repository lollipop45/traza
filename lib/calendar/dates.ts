import type { ISODate } from "./types";

// Dates are handled as UTC midnights so that formatting never shifts a day with the server's time zone.

const DAY_MS = 86_400_000;

export function parseISODate(iso: ISODate): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function toISODate(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

export function isValidISODate(value: string): value is ISODate {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && toISODate(parseISODate(value)) === value;
}

/**
 * Time zone that defines "today" for real data (tasks). Calendar dates are compared as plain
 * YYYY-MM-DD strings, so this is the only place a time zone enters the picture.
 */
export const APP_TIME_ZONE = "Atlantic/Canary";

/** Today's calendar date in `timeZone`, independent of the server's own zone (e.g. UTC on a host). */
export function currentISODate(timeZone: string = APP_TIME_ZONE): ISODate {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function addDays(iso: ISODate, days: number): ISODate {
  const date = parseISODate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toISODate(date);
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / DAY_MS);
}

function format(iso: ISODate, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", ...options }).format(parseISODate(iso));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Lunes, 5 de octubre de 2026" */
export function formatLongDate(iso: ISODate): string {
  return capitalize(format(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
}

/** "Lunes, 5 de octubre" */
export function formatDayHeading(iso: ISODate): string {
  return capitalize(format(iso, { weekday: "long", day: "numeric", month: "long" }));
}

/** "Octubre 2026" */
export function formatMonthYear(iso: ISODate): string {
  return capitalize(format(iso, { month: "long", year: "numeric" })).replace(" de ", " ");
}

/** "OCT" */
export function formatShortMonth(iso: ISODate): string {
  return format(iso, { month: "short" }).replace(".", "").toUpperCase();
}

/** "12 OCT" */
export function formatDayMonth(iso: ISODate): string {
  return `${parseISODate(iso).getUTCDate()} ${formatShortMonth(iso)}`;
}

/** "5 OCT 2026" */
export function formatShortDate(iso: ISODate): string {
  const date = parseISODate(iso);
  return `${date.getUTCDate()} ${formatShortMonth(iso)} ${date.getUTCFullYear()}`;
}

/** "05.10.26" */
export function formatCompactDate(iso: ISODate): string {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year.slice(2)}`;
}

export function isoWeekNumber(iso: ISODate): number {
  const date = parseISODate(iso);
  const weekday = date.getUTCDay() || 7;
  // Thursday of the same ISO week decides which year the week belongs to.
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
}

export type MonthDay = {
  date: ISODate;
  day: number;
  inMonth: boolean;
};

/** Weeks (Monday first) covering the month of `iso`, padded with the adjacent months' days. */
export function buildMonthWeeks(iso: ISODate): MonthDay[][] {
  const date = parseISODate(iso);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const leading = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cellCount = Math.ceil((leading + daysInMonth) / 7) * 7;

  const weeks: MonthDay[][] = [];
  for (let i = 0; i < cellCount; i++) {
    const cell = new Date(Date.UTC(year, month, 1 - leading + i));
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({
      date: toISODate(cell),
      day: cell.getUTCDate(),
      inMonth: cell.getUTCMonth() === month,
    });
  }
  return weeks;
}
