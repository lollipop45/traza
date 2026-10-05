/** ISO calendar date, e.g. "2026-10-05". */
export type ISODate = string;

/** 24h local time, e.g. "09:30". */
export type TimeOfDay = string;

/** Where an event comes from. Only "manual" exists today; the rest are reserved for future sync. */
export type EventSource = "manual" | "google-calendar" | "canvas";

export type EventCategory = "arquitectura" | "universidad" | "astronomia" | "personal";

/** Deadlines (entregas) are academic submissions and get a distinct, subtle treatment. */
export type EventKind = "event" | "deadline";

export type CalendarEvent = {
  id: string;
  title: string;
  date: ISODate;
  /** Omitted for all-day items. */
  startTime?: TimeOfDay;
  endTime?: TimeOfDay;
  location?: string;
  /** Subject or studio the item belongs to, e.g. "Taller de Proyectos". */
  course?: string;
  category: EventCategory;
  kind: EventKind;
  source: EventSource;
  /** Identifier in the originating service, for de-duplication when syncing. */
  externalId?: string;
};
