import "server-only";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { TaskDetails } from "./validation";

// The single write path for new tasks, shared by Home quick capture and Inbox capture. Callers
// must already have verified the session (requireUser) and parsed the input (validation.ts).

/** Every view that shows tasks. */
const TASK_VIEWS = [
  "/", // the task list
  "/projects", // task counts per project
  "/calendar", // due dates as deadline items
  "/inbox", // the unified capture feed
];

export function revalidateTaskViews() {
  for (const path of TASK_VIEWS) revalidatePath(path);
}

/**
 * Inserts an already-validated task. status, source, user_id and timestamps come from database
 * defaults; a project_id must belong to the same user (tasks_project_owner_fkey).
 * Returns false on any database error (not logged: errors can echo data).
 */
export async function insertTask(details: TaskDetails): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("tasks").insert(details);
  return !error;
}
