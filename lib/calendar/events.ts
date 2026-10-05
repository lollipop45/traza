import type { CalendarEvent, ISODate } from "./types";

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return (a.date + (a.startTime ?? "")).localeCompare(b.date + (b.startTime ?? ""));
}

export function getEventsOn(events: CalendarEvent[], date: ISODate): CalendarEvent[] {
  return events.filter((event) => event.date === date).sort(byStart);
}

export function getUpcomingDeadlines(events: CalendarEvent[], from: ISODate): CalendarEvent[] {
  return events.filter((event) => event.kind === "deadline" && event.date >= from).sort(byStart);
}

export function getEventsInMonth(events: CalendarEvent[], month: ISODate): CalendarEvent[] {
  const prefix = month.slice(0, 7);
  return events.filter((event) => event.date.startsWith(prefix));
}

export function groupByDate(events: CalendarEvent[]): Map<ISODate, CalendarEvent[]> {
  const groups = new Map<ISODate, CalendarEvent[]>();
  for (const event of [...events].sort(byStart)) {
    groups.set(event.date, [...(groups.get(event.date) ?? []), event]);
  }
  return groups;
}
