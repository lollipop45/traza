import type { Tables } from "@/lib/supabase/database.types";

/** A row of `public.projects`, exactly as generated from the database. */
export type ProjectRow = Tables<"projects">;

/** Columns the Projects screen reads: a deliberate projection of `ProjectRow`. */
export type ProjectSummary = Pick<ProjectRow, "id" | "name" | "area" | "description" | "status" | "progress" | "created_at">;
export const PROJECT_SUMMARY_COLUMNS = "id, name, area, description, status, progress, created_at";

/** Derived from `public.tasks`, never stored on the project. */
export type ProjectTaskCounts = { taskCount: number; pendingTaskCount: number };

export type ProjectWithCounts = ProjectSummary &
  ProjectTaskCounts & {
    /** At least one Canvas course is linked to it (derived from canvas_course_links). */
    campusLinked: boolean;
  };

/** What task forms and task rows need: the name to display and whether it is still assignable. */
export type ProjectOption = Pick<ProjectRow, "id" | "name" | "status">;
export const PROJECT_OPTION_COLUMNS = "id, name, status";

/** Mirror the check constraints in 20261005160009_create_projects.sql. */
export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_AREA_MAX_LENGTH = 60;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2000;

/** Mirrors `projects_status_valid`. The column itself is typed as text. Order = display order. */
export const PROJECT_STATUSES = ["active", "planned", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const DEFAULT_PROJECT_STATUS: ProjectStatus = "active";

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}
