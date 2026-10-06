import type { Tables } from "@/lib/supabase/database.types";

/** A row of `public.tasks`, exactly as generated from the database. */
export type TaskRow = Tables<"tasks">;

/** The columns the Home task list needs: a deliberate projection of `TaskRow`, not a second model. */
export type HomeTask = Pick<TaskRow, "id" | "title" | "status" | "priority" | "due_date" | "completed_at" | "project_id" | "source">;

/** Column list for queries returning `HomeTask`, kept next to the type it must match. */
export const HOME_TASK_COLUMNS = "id, title, status, priority, due_date, completed_at, project_id, source";

/** A task as the Inbox shows it: the Home projection plus when it was captured. */
export type InboxTask = HomeTask & Pick<TaskRow, "created_at">;
export const INBOX_TASK_COLUMNS = `${HOME_TASK_COLUMNS}, created_at`;

/** The columns the calendar needs to show a task as a deadline item. */
export type DeadlineTask = Pick<TaskRow, "id" | "title" | "status" | "due_date" | "project_id" | "source">;
export const DEADLINE_TASK_COLUMNS = "id, title, status, due_date, project_id, source";

/** Mirrors the `tasks_title_not_blank` check constraint (1–500 characters after trimming). */
export const TASK_TITLE_MAX_LENGTH = 500;

/** Mirrors the `tasks_priority_valid` check constraint. The column itself is typed as text. */
export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const DEFAULT_TASK_PRIORITY: TaskPriority = "normal";

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

export function isDone(task: Pick<TaskRow, "status">): boolean {
  return task.status === "done";
}

/** Plain deletion of a Campus task is refused: "Ignorar en TRAZA" is the only way to remove one. */
export const CANVAS_TASK_DELETE_MESSAGE = "Las tareas de Campus se quitan con «Ignorar en TRAZA».";

/**
 * Imported from Campus (source = 'canvas'). Its title, due date and project belong to Canvas and are
 * rewritten by every sync, so TRAZA only lets the user change its priority and completion. It is not
 * deleted plainly (the next sync would recreate it): "Ignorar en TRAZA" records the assignment as
 * ignored and removes the task together (lib/canvas/assignment-actions.ts).
 */
export function isCanvasTask(task: Pick<TaskRow, "source">): boolean {
  return task.source === "canvas";
}
