import { CalendarDays, FileText, Layers, Lightbulb, SquareCheck, type LucideIcon } from "lucide-react";

/** One outline icon per kind of record, shared by Inbox items and assistant actions. */
export const itemTypeIcons = {
  task: SquareCheck,
  event: CalendarDays,
  idea: Lightbulb,
  note: FileText,
  project: Layers,
} satisfies Record<string, LucideIcon>;
