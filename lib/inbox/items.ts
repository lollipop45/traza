import { daysBetween, formatShortDate } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import type { InboxItem, InboxItemType } from "./types";

export type InboxFilter = {
  /** Value of the `?tipo=` search param; `null` for "Todo". */
  slug: string | null;
  label: string;
  type: InboxItemType | null;
};

export const inboxFilters: InboxFilter[] = [
  { slug: null, label: "Todo", type: null },
  { slug: "tareas", label: "Tareas", type: "task" },
  { slug: "ideas", label: "Ideas", type: "idea" },
  { slug: "notas", label: "Notas", type: "note" },
];

export function resolveInboxFilter(slug: unknown): InboxFilter {
  return inboxFilters.find((filter) => filter.slug === slug) ?? inboxFilters[0];
}

export function filterInboxItems(items: InboxItem[], filter: InboxFilter): InboxItem[] {
  return filter.type ? items.filter((item) => item.type === filter.type) : items;
}

export const inboxTypeLabels: Record<InboxItemType, string> = {
  task: "Tarea",
  idea: "Idea",
  note: "Nota",
};

/** Tasks show when they are due ("Hoy", "Mañana", "9 OCT 2026"); ideas and notes show when they were captured. */
export function formatInboxDate(item: InboxItem, today: ISODate): string {
  if (item.type === "task" && item.dueDate) {
    const days = daysBetween(today, item.dueDate);
    if (days === 0) return "Hoy";
    if (days === 1) return "Mañana";
    return formatShortDate(item.dueDate);
  }
  return formatShortDate(item.createdAt.slice(0, 10));
}
