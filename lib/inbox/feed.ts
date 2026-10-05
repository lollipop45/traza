import { addDays, formatDayMonth, formatShortDate, isoDateInZone } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { projectNameMap } from "@/lib/calendar/items";
import type { ProjectOption } from "@/lib/projects/types";
import { formatDueLabel } from "@/lib/tasks/format";
import type { InboxTask } from "@/lib/tasks/types";
import type { EntryKind, InboxCapture, InboxCaptureEntry, InboxEntry, InboxTaskEntry } from "./types";

// Pure projection of tasks + ideas/notes into one Inbox feed. No data access here.

export type InboxFilter = {
  /** Value of the `?tipo=` search param; `null` for "Todo". */
  slug: string | null;
  label: string;
  kind: EntryKind | null;
};

export const inboxFilters: InboxFilter[] = [
  { slug: null, label: "Todo", kind: null },
  { slug: "tareas", label: "Tareas", kind: "task" },
  { slug: "ideas", label: "Ideas", kind: "idea" },
  { slug: "notas", label: "Notas", kind: "note" },
];

export function resolveInboxFilter(slug: unknown): InboxFilter {
  return inboxFilters.find((filter) => filter.slug === slug) ?? inboxFilters[0];
}

export function filterEntries(entries: InboxEntry[], filter: InboxFilter): InboxEntry[] {
  return filter.kind ? entries.filter((entry) => entry.kind === filter.kind) : entries;
}

export const inboxTypeLabels: Record<EntryKind, string> = {
  task: "Tarea",
  idea: "Idea",
  note: "Nota",
};

/** Newest first; ties (same instant) by id, so the order is deterministic. */
export function compareEntries(a: InboxEntry, b: InboxEntry): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
}

/** Merges both sources. Task entries carry the real task row; nothing is copied or duplicated. */
export function buildInboxFeed(
  tasks: InboxTask[],
  captures: InboxCapture[],
  projects: Pick<ProjectOption, "id" | "name">[],
): InboxEntry[] {
  const names = projectNameMap(projects);
  const projectName = (id: string | null) => (id ? (names.get(id) ?? null) : null);

  const taskEntries: InboxTaskEntry[] = tasks.map((task) => ({
    kind: "task",
    id: task.id,
    task,
    createdAt: task.created_at,
    projectName: projectName(task.project_id),
  }));
  const captureEntries: InboxCaptureEntry[] = captures
    .filter((capture): capture is InboxCapture & { kind: "idea" | "note" } => capture.kind === "idea" || capture.kind === "note")
    .map((capture) => ({
      kind: capture.kind,
      id: capture.id,
      title: capture.title,
      content: capture.content,
      projectId: capture.project_id,
      projectName: projectName(capture.project_id),
      source: capture.source,
      createdAt: capture.created_at,
    }));

  return [...taskEntries, ...captureEntries].sort(compareEntries);
}

export type DateLabel = { text: string; /** Today or overdue. */ emphasis: boolean };

/**
 * Tasks with a due date show it ("Hoy", "Mañana", "Vencida · 4 OCT", "12 OCT"); everything else
 * shows when it was captured, as a calendar day in the app time zone ("Hoy", "Ayer", "3 OCT").
 */
export function entryDateLabel(entry: InboxEntry, today: ISODate): DateLabel {
  if (entry.kind === "task" && entry.task.due_date) {
    const due = formatDueLabel(entry.task.due_date, today);
    if (due) return { text: due.text, emphasis: due.urgent && entry.task.status !== "done" };
  }
  const captured = isoDateInZone(entry.createdAt);
  if (captured === today) return { text: "Hoy", emphasis: false };
  if (captured === addDays(today, -1)) return { text: "Ayer", emphasis: false };
  return { text: captured.slice(0, 4) === today.slice(0, 4) ? formatDayMonth(captured) : formatShortDate(captured), emphasis: false };
}
