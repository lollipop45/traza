import { isValidISODate } from "./dates";
import type { ISODate } from "./types";

// Calendar navigation lives in the URL: ?mes=YYYY-MM&dia=YYYY-MM-DD (plus ?nuevo / ?editar for
// panels). Everything renders on the server; links are the only "state".

/** Months the calendar can show; matches the date range accepted for tasks and events. */
const MIN_MONTH = "2000-01";
const MAX_MONTH = "2100-12";

export type CalendarView = {
  /** First day of the displayed month, e.g. "2026-11-01". */
  month: ISODate;
  /** Selected day, always inside `month`. */
  selected: ISODate;
};

function isMonthParam(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}$/.test(value) &&
    isValidISODate(`${value}-01`) &&
    value >= MIN_MONTH &&
    value <= MAX_MONTH
  );
}

/** "YYYY-MM" of an ISO date. */
export function monthKey(date: ISODate): string {
  return date.slice(0, 7);
}

/** Last day of the month that starts at `month` ("YYYY-MM-01"). */
export function lastDayOfMonth(month: ISODate): ISODate {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
}

/** "YYYY-MM" shifted by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/**
 * Resolves the URL into a valid view:
 *   - month: ?mes, else the month of a valid ?dia, else today's month (app time zone);
 *   - selected: ?dia if it falls in that month, else today if it does, else the 1st.
 * Invalid or out-of-range values fall back silently.
 */
export function resolveCalendarView(params: { mes?: unknown; dia?: unknown }, today: ISODate): CalendarView {
  const dia = typeof params.dia === "string" && isValidISODate(params.dia) && isMonthParam(monthKey(params.dia)) ? params.dia : null;
  const mes = isMonthParam(params.mes) ? params.mes : dia ? monthKey(dia) : monthKey(today);
  const selected = dia && monthKey(dia) === mes ? dia : monthKey(today) === mes ? today : `${mes}-01`;
  return { month: `${mes}-01`, selected };
}

/** Calendar URL for a month/day, with an optional panel (`nuevo` or `editar=<id>`). */
export function calendarHref(
  view: { month: string; selected?: ISODate },
  panel?: { nuevo: true } | { editar: string },
): string {
  const params = new URLSearchParams({ mes: monthKey(view.month) });
  if (view.selected) params.set("dia", view.selected);
  if (panel && "nuevo" in panel) params.set("nuevo", "1");
  if (panel && "editar" in panel) params.set("editar", panel.editar);
  return `/calendar?${params.toString()}`;
}

/** Previous / next month links; no day, so the target month picks today or its 1st. */
export function adjacentMonthHrefs(month: ISODate): { previous: string | null; next: string | null } {
  const key = monthKey(month);
  const previous = addMonths(key, -1);
  const next = addMonths(key, 1);
  return {
    previous: previous >= MIN_MONTH ? calendarHref({ month: previous }) : null,
    next: next <= MAX_MONTH ? calendarHref({ month: next }) : null,
  };
}
