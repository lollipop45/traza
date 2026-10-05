"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isTaskId, parseTaskDetails } from "./validation";

// Every mutation: verifies the session, validates its input here on the server, and relies on RLS
// for ownership. None accepts a user_id; the column is not even writable by `authenticated`
// (column-scoped grants) and the database fills it with auth.uid(). Only the editable fields
// (title, due_date, priority, project_id, status/completed_at) are ever written. A project_id must
// belong to the same user: the database rejects anything else (tasks_project_owner_fkey). Errors
// become fixed Spanish messages and are never logged or echoed.

const HOME_PATH = "/";
const PROJECTS_PATH = "/projects";
const CALENDAR_PATH = "/calendar";

/** Home lists the tasks; Projects derives its task counts; Calendar shows their due dates. */
function revalidateTaskViews() {
  revalidatePath(HOME_PATH);
  revalidatePath(PROJECTS_PATH);
  revalidatePath(CALENDAR_PATH);
}

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

  const supabase = await createClient();
  // status, source, user_id and timestamps come from database defaults.
  const { error } = await supabase.from("tasks").insert(parsed.value);
  if (error) return { ...previous, error: "No se ha podido crear la tarea.", title: echo };

  revalidateTaskViews();
  return { error: null, title: "", created: previous.created + 1 };
}

export type TaskMutationResult = { ok: true } | { ok: false; error: string };

export async function updateTask(taskId: string, formData: FormData): Promise<TaskMutationResult> {
  await requireUser();
  const failed: TaskMutationResult = { ok: false, error: "No se ha podido actualizar la tarea." };
  if (!isTaskId(taskId)) return failed;

  const parsed = parseTaskDetails(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();
  const { data, error } = await supabase.from("tasks").update(parsed.value).eq("id", taskId).select("id");
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
  const { data, error } = await supabase.from("tasks").delete().eq("id", taskId).select("id");
  if (error || data.length === 0) return failed;

  revalidateTaskViews();
  return { ok: true };
}
