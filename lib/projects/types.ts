import type { ISODate } from "@/lib/calendar/types";

/** Stable slug shared by projects, calendar events and inbox items, e.g. "taller-proyectos". */
export type ProjectId = string;

export type ProjectStatus = "active" | "planned" | "archived";

export type ProjectArea = "arquitectura" | "universidad" | "programacion" | "personal";

/** Where a project came from. Only "manual" exists today; "canvas" and "ai" are reserved. */
export type ProjectSource = "manual" | "canvas" | "ai";

export type Project = {
  id: ProjectId;
  name: string;
  area: ProjectArea;
  description: string;
  status: ProjectStatus;
  /** 0–100. */
  progress: number;
  createdAt: ISODate;
  taskCount: number;
  pendingTaskCount: number;
  /** Calendar event that marks the next milestone; omitted when there is no fixed date. */
  nextMilestoneEventId?: string;
  tags: string[];
  source: ProjectSource;
};
