"use server";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { insertTask, revalidateTaskViews } from "./mutations";
import { CANVAS_TASK_DELETE_MESSAGE } from "./types";
import { isTaskId, parseTaskDetails, parseTaskEdit } from "./validation";

// Every mutation: verifies the session, validates its input here on the server, and relies on RLS
// for ownership. None accepts a user_id; the column is not even writable by `authenticated`
// (column-scoped grants) and the database fills it with auth.uid(). Only the editable fields
// (title, due_date, priority, project_id, status/completed_at) are ever written. A project_id must
// belong to the same user: the database rejects anything else (tasks_project_owner_fkey). Tasks
// imported from Campus (source = 'canvas') accept only priority and completion here, and are never
// deleted here (see ignoreCanvasTask in lib/canvas/assignment-actions.ts). Errors become fixed Spanish messages and are never logged or echoed.

export type CreateTaskState = {
  error: string | null;
  /** Echoed back so the text survives a failed attempt; empty after success so the field clears. */
  title: string;
  /** Increments on every successful create, so the form can reset its option controls. */
  created: number;
};

export async function createTask(previous: CreateTaskState, formData: FormData): Promise<CreateTaskState> {
  await requireUser();

  const parsed = parseTaskDetails(formData);
  const rawTitle = formData.get("title");
  const echo = typeof rawTitle === "string" ? rawTitle : "";
  if (!parsed.ok) return { ...previous, error: parsed.error, title: echo };

  if (!(await insertTask(parsed.value))) return { ...previous, error: "No se ha podido crear la tarea.", title: echo };

  revalidateTaskViews();
  return { error: null, title: "", created: previous.created + 1 };
}

export type TaskMutationResult = { ok: true } | { ok: false; error: string };

/** The task's stored source, or null when it does not exist / is not the caller's (RLS). */
async function taskSource(supabase: Awaited<ReturnType<typeof createClient>>, taskId: string): Promise<string | null> {
  const { data, error } = await supabase.from("tasks").select("source").eq("id", taskId).maybeSingle();
  return error || !data ? null : data.source;
}

export async function updateTask(taskId: string, formData: FormData): Promise<TaskMutationResult> {
  await requireUser();
  const failed: TaskMutationResult = { ok: false, error: "No se ha podido actualizar la tarea." };
  if (!isTaskId(taskId)) return failed;

  const supabase = await createClient();
  const source = await taskSource(supabase, taskId);
  if (!source) return failed;

  // Canvas tasks: priority only (title, due date and project are Canvas-managed).
  const parsed = parseTaskEdit(source, formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Filtering on the source read above means a concurrent change of kind can never widen the edit.
  const { data, error } = await supabase.from("tasks").update(parsed.value).eq("id", taskId).eq("source", source).select("id");
  // Zero rows: the task does not exist or belongs to someone else (filtered out by RLS).
  if (error || data.length === 0) return failed;

  revalidateTaskViews();
  return { ok: true };
}

export async function setTaskCompleted(taskId: string, completed: boolean): Promise<TaskMutationResult> {
  await requireUser();
  const failed: TaskMutationResult = { ok: false, error: "No se ha podido actualizar la tarea." };
  if (!isTaskId(taskId) || typeof completed !== "boolean") return failed;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .update(
      completed
        ? { status: "done", completed_at: new Date().toISOString() }
        : { status: "pending", completed_at: null },
    )
    .eq("id", taskId)
    .select("id");
  if (error || data.length === 0) return failed;

  revalidateTaskViews();
  return { ok: true };
}

export async function deleteTask(taskId: string): Promise<TaskMutationResult> {
  await requireUser();
  const failed: TaskMutationResult = { ok: false, error: "No se ha podido eliminar la tarea." };
  if (!isTaskId(taskId)) return failed;

  const supabase = await createClient();
  // Canvas tasks are not deleted locally: the next sync would recreate them.
  const source = await taskSource(supabase, taskId);
  if (!source) return failed;
  if (source === "canvas") return { ok: false, error: CANVAS_TASK_DELETE_MESSAGE };

  const { data, error } = await supabase.from("tasks").delete().eq("id", taskId).neq("source", "canvas").select("id");
  if (error || data.length === 0) return failed;

  revalidateTaskViews();
  return { ok: true };
}
