"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { TASK_TITLE_MAX_LENGTH } from "./types";

// Mutations never accept a user_id: ownership comes from the verified session. The column is not
// even writable by `authenticated` (column-scoped grants); the database fills it with auth.uid()
// and RLS checks it. Errors are mapped to fixed Spanish messages and never logged or echoed.

export type CreateTaskState = {
  error: string | null;
  /** Echoed back so the text survives a failed attempt; empty after success so the field clears. */
  title: string;
};

export async function createTask(_previous: CreateTaskState, formData: FormData): Promise<CreateTaskState> {
  await requireUser();

  const raw = formData.get("title");
  const title = typeof raw === "string" ? raw.trim() : "";

  if (!title) return { error: "Escribe la tarea antes de guardarla.", title: "" };
  // Count code points, as Postgres char_length() does.
  if ([...title].length > TASK_TITLE_MAX_LENGTH) {
    return { error: `La tarea no puede superar los ${TASK_TITLE_MAX_LENGTH} caracteres.`, title };
  }

  const supabase = await createClient();
  // status, priority, source, due_date, user_id, timestamps: database defaults.
  const { error } = await supabase.from("tasks").insert({ title });
  if (error) return { error: "No se ha podido crear la tarea.", title };

  revalidatePath("/");
  return { error: null, title: "" };
}

export type UpdateTaskResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setTaskCompleted(taskId: string, completed: boolean): Promise<UpdateTaskResult> {
  await requireUser();
  const failed: UpdateTaskResult = { ok: false, error: "No se ha podido actualizar la tarea." };
  if (typeof taskId !== "string" || !UUID.test(taskId) || typeof completed !== "boolean") return failed;

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

  // Zero rows means the task does not exist or belongs to someone else (filtered out by RLS).
  if (error || data.length === 0) return failed;

  revalidatePath("/");
  return { ok: true };
}
