import type { CalendarEvent } from "@/lib/calendar/types";
import type { Project, ProjectArea, ProjectStatus } from "./types";

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

export function filterProjects(projects: Project[], filter: ProjectFilter): Project[] {
  return filter.status ? projects.filter((project) => project.status === filter.status) : projects;
}

export const projectStatusLabels: Record<ProjectStatus, string> = {
  active: "En curso",
  planned: "Planificado",
  archived: "Archivado",
};

export const projectAreaLabels: Record<ProjectArea, string> = {
  arquitectura: "Arquitectura",
  universidad: "Universidad",
  programacion: "Programación",
  personal: "Personal",
};

export function findMilestone(project: Project, events: CalendarEvent[]): CalendarEvent | undefined {
  return events.find((event) => event.id === project.nextMilestoneEventId);
}
