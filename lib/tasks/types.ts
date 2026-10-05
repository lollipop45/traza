import type { Tables } from "@/lib/supabase/database.types";

/** A row of `public.tasks`, exactly as generated from the database. */
export type TaskRow = Tables<"tasks">;

/** The columns the Home task list needs: a deliberate projection of `TaskRow`, not a second model. */
export type HomeTask = Pick<TaskRow, "id" | "title" | "status" | "due_date" | "completed_at">;

/** Column list for queries returning `HomeTask`, kept next to the type it must match. */
export const HOME_TASK_COLUMNS = "id, title, status, due_date, completed_at";

/** Mirrors the `tasks_title_not_blank` check constraint (1–500 characters after trimming). */
export const TASK_TITLE_MAX_LENGTH = 500;

export function isDone(task: Pick<TaskRow, "status">): boolean {
  return task.status === "done";
}
