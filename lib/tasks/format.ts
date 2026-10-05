import { daysBetween, formatDayMonth, formatShortDate } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import type { TaskPriority } from "./types";

export type DueLabel = {
  text: string;
  /** Due today or overdue: rendered in charcoal instead of gray. */
  urgent: boolean;
};

/** "Hoy", "Mañana", "Vencida · 4 OCT", "12 OCT" ("12 OCT 2027" in another year); null without a date. */
export function formatDueLabel(dueDate: ISODate | null, today: ISODate): DueLabel | null {
  if (!dueDate) return null;
  const days = daysBetween(today, dueDate);
  if (days === 0) return { text: "Hoy", urgent: true };
  if (days === 1) return { text: "Mañana", urgent: false };
  const date = dueDate.slice(0, 4) === today.slice(0, 4) ? formatDayMonth(dueDate) : formatShortDate(dueDate);
  return days < 0 ? { text: `Vencida · ${date}`, urgent: true } : { text: date, urgent: false };
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Baja",
  normal: "Normal",
  high: "Alta",
};
