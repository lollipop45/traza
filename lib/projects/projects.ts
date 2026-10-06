import type { CalendarEventRow, ISODate } from "@/lib/calendar/types";
import type { TaskRow } from "@/lib/tasks/types";
import {
  PROJECT_STATUSES,
  isProjectStatus,
  type ProjectMilestone,
  type ProjectOption,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTaskCounts,
  type ProjectWithCounts,
} from "./types";

// Pure helpers for the Projects screen and task forms. No data access here.

export type ProjectFilter = {
  /** Value of the `?estado=` search param; `null` for "Todos". */
  slug: string | null;
  label: string;
  status: ProjectStatus | null;
};

export const projectFilters: ProjectFilter[] = [
  { slug: null, label: "Todos", status: null },
  { slug: "activos", label: "En curso", status: "active" },
  { slug: "planificados", label: "Planificados", status: "planned" },
  { slug: "archivados", label: "Archivados", status: "archived" },
];

export function resolveProjectFilter(slug: unknown): ProjectFilter {
  return projectFilters.find((filter) => filter.slug === slug) ?? projectFilters[0];
}

export function filterProjects<T extends Pick<ProjectSummary, "status">>(projects: T[], filter: ProjectFilter): T[] {
  return filter.status ? projects.filter((project) => project.status === filter.status) : projects;
}

export const projectStatusLabels: Record<ProjectStatus, string> = {
  active: "En curso",
  planned: "Planificado",
  archived: "Archivado",
};

/** Label for a status read from the database (typed as text); unknown values fall back to the raw text. */
export function projectStatusLabel(status: string): string {
  return isProjectStatus(status) ? projectStatusLabels[status] : status;
}

function statusRank(status: string): number {
  const rank = (PROJECT_STATUSES as readonly string[]).indexOf(status);
  return rank === -1 ? PROJECT_STATUSES.length : rank;
}

/**
 * Index order: in course, then planned, then archived; oldest first within each group, id as a
 * stable tie-breaker. The visual numbers (01, 02, …) are positions in this order, never stored.
 */
export function sortProjects<T extends Pick<ProjectSummary, "id" | "status" | "created_at">>(projects: T[]): T[] {
  return [...projects].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
}

/** Total and pending tasks per project id, from task rows that carry a project. */
export function countTasksByProject(
  tasks: Pick<TaskRow, "project_id" | "status">[],
): Map<string, ProjectTaskCounts> {
  const counts = new Map<string, ProjectTaskCounts>();
  for (const task of tasks) {
    if (!task.project_id) continue;
    const entry = counts.get(task.project_id) ?? { taskCount: 0, pendingTaskCount: 0 };
    entry.taskCount += 1;
    if (task.status !== "done") entry.pendingTaskCount += 1;
    counts.set(task.project_id, entry);
  }
  return counts;
}

export type MilestoneTask = Pick<TaskRow, "id" | "project_id" | "status" | "due_date" | "title">;
export type MilestoneEvent = Pick<CalendarEventRow, "id" | "project_id" | "event_date" | "title">;

type RankedMilestone = ProjectMilestone & { id: string };

/** Same-day order: task deadlines before events (as in the calendar), then title, then id. */
function compareMilestones(a: RankedMilestone, b: RankedMilestone): number {
  return (
    a.date.localeCompare(b.date) ||
    (a.kind === b.kind ? 0 : a.kind === "task" ? -1 : 1) ||
    a.title.localeCompare(b.title, "es") ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Each project's next milestone: the earliest of its pending tasks due today or later and its
 * calendar events today or later. Overdue or completed tasks and past events are not "next".
 */
export function nextMilestones(tasks: MilestoneTask[], events: MilestoneEvent[], today: ISODate): Map<string, ProjectMilestone> {
  const best = new Map<string, RankedMilestone>();
  const consider = (projectId: string | null, candidate: RankedMilestone) => {
    if (!projectId || candidate.date < today) return;
    const current = best.get(projectId);
    if (!current || compareMilestones(candidate, current) < 0) best.set(projectId, candidate);
  };
  for (const task of tasks) {
    if (task.status === "done" || !task.due_date) continue;
    consider(task.project_id, { kind: "task", title: task.title, date: task.due_date, id: task.id });
  }
  for (const event of events) consider(event.project_id, { kind: "event", title: event.title, date: event.event_date, id: event.id });
  return new Map([...best].map(([projectId, { kind, title, date }]) => [projectId, { kind, title, date }]));
}

export function withTaskCounts(
  projects: ProjectSummary[],
  tasks: Pick<TaskRow, "project_id" | "status">[],
  campusLinkedIds: ReadonlySet<string> = new Set(),
  milestones: ReadonlyMap<string, ProjectMilestone> = new Map(),
): ProjectWithCounts[] {
  const counts = countTasksByProject(tasks);
  return projects.map((project) => ({
    ...project,
    ...(counts.get(project.id) ?? { taskCount: 0, pendingTaskCount: 0 }),
    campusLinked: campusLinkedIds.has(project.id),
    nextMilestone: milestones.get(project.id) ?? null,
  }));
}

/** Projects a task can newly be assigned to: in course or planned, never archived. */
export function isAssignable(project: Pick<ProjectOption, "status">): boolean {
  return project.status === "active" || project.status === "planned";
}

/**
 * Choices for a task's project field: every assignable project, plus the task's current project
 * even if archived (so editing a task never silently drops it). Keeps the given order.
 */
export function projectChoices(projects: ProjectOption[], currentId: string | null): ProjectOption[] {
  return projects.filter((project) => isAssignable(project) || project.id === currentId);
}

/** The user's own areas, deduplicated (case-insensitively) and sorted, as typing suggestions. */
export function distinctAreas(projects: Pick<ProjectSummary, "area">[]): string[] {
  const byKey = new Map<string, string>();
  for (const { area } of projects) {
    if (area && !byKey.has(area.toLocaleLowerCase("es"))) byKey.set(area.toLocaleLowerCase("es"), area);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "es"));
}

export function countActiveProjects(projects: Pick<ProjectOption, "status">[]): number {
  return projects.filter((project) => project.status === "active").length;
}
