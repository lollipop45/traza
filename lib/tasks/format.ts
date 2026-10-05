import { daysBetween, formatDayMonth } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";

export type DueLabel = {
  text: string;
  /** Due today or overdue: rendered in charcoal instead of gray. */
  urgent: boolean;
};

/** "Hoy", "Mañana" or "12 OCT"; null when the task has no due date. */
export function formatDueLabel(dueDate: ISODate | null, today: ISODate): DueLabel | null {
  if (!dueDate) return null;
  const days = daysBetween(today, dueDate);
  if (days === 0) return { text: "Hoy", urgent: true };
  if (days === 1) return { text: "Mañana", urgent: false };
  return { text: formatDayMonth(dueDate), urgent: days < 0 };
}
