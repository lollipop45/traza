import type { ProjectOption } from "@/lib/projects/types";
import type { DeadlineTask } from "@/lib/tasks/types";
import type { CalendarEventItem, CalendarEventRecord, CalendarItem, ISODate, TaskDeadlineItem } from "./types";

// Pure projections from database rows to the calendar's rendering model. No data access here.

type ProjectNames = Map<string, string>;

export function projectNameMap(projects: Pick<ProjectOption, "id" | "name">[]): ProjectNames {
  return new Map(projects.map((project) => [project.id, project.name]));
}

/** "HH:MM:SS" (Postgres time) → "HH:MM". */
function toTimeOfDay(time: string | null): string | null {
  return time ? time.slice(0, 5) : null;
}

export function eventToItem(event: CalendarEventRecord, projectNames: ProjectNames): CalendarEventItem {
  return {
    itemType: "event",
    id: event.id,
    title: event.title,
    date: event.event_date,
    startTime: event.all_day ? null : toTimeOfDay(event.start_time),
    endTime: event.all_day ? null : toTimeOfDay(event.end_time),
    allDay: event.all_day,
    location: event.location,
    projectName: event.project_id ? (projectNames.get(event.project_id) ?? null) : null,
    source: event.source,
  };
}

/** Null for tasks without a due date: they are not calendar items. */
export function taskToDeadlineItem(task: DeadlineTask, projectNames: ProjectNames): TaskDeadlineItem | null {
  if (!task.due_date) return null;
  return {
    itemType: "task-deadline",
    id: task.id,
    title: task.title,
    date: task.due_date,
    projectName: task.project_id ? (projectNames.get(task.project_id) ?? null) : null,
    done: task.status === "done",
  };
}

/** Position within a day: task deadlines, then all-day events, then timed events by start. */
function slot(item: CalendarItem): string {
  if (item.itemType === "task-deadline") return "0";
  return item.allDay ? "1" : `2${item.startTime}`;
}

export function compareItems(a: CalendarItem, b: CalendarItem): number {
  return (
    a.date.localeCompare(b.date) ||
    slot(a).localeCompare(slot(b)) ||
    a.title.localeCompare(b.title, "es") ||
    a.id.localeCompare(b.id)
  );
}

/** Both sources merged into one sorted list. */
export function buildCalendarItems(
  events: CalendarEventRecord[],
  tasks: DeadlineTask[],
  projects: Pick<ProjectOption, "id" | "name">[],
): CalendarItem[] {
  const names = projectNameMap(projects);
  const deadlines = tasks.map((task) => taskToDeadlineItem(task, names)).filter((item) => item !== null);
  return [...events.map((event) => eventToItem(event, names)), ...deadlines].sort(compareItems);
}

export function itemsOn<T extends CalendarItem>(items: T[], date: ISODate): T[] {
  return items.filter((item) => item.date === date);
}

export function groupItemsByDate(items: CalendarItem[]): Map<ISODate, CalendarItem[]> {
  const groups = new Map<ISODate, CalendarItem[]>();
  for (const item of [...items].sort(compareItems)) groups.set(item.date, [...(groups.get(item.date) ?? []), item]);
  return groups;
}

export function isEventItem(item: CalendarItem): item is CalendarEventItem {
  return item.itemType === "event";
}

/**
 * Próximas entregas: pending tasks with a due date, overdue ones included (they still need doing),
 * oldest date first. Completed tasks are never upcoming.
 */
export function upcomingDeadlines(tasks: DeadlineTask[], projects: Pick<ProjectOption, "id" | "name">[]): TaskDeadlineItem[] {
  const names = projectNameMap(projects);
  return tasks
    .filter((task) => task.status !== "done")
    .map((task) => taskToDeadlineItem(task, names))
    .filter((item) => item !== null)
    .sort(compareItems);
}
