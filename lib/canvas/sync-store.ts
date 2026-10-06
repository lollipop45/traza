import "server-only";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { CanvasTaskWrite } from "./assignments";
import type { UpsertOutcome } from "./sync";

// Supabase access for the Canvas assignment sync. Server-only; callers must have verified the
// session and the Canvas course. Errors are not logged (they can echo data). No Canvas token here.

/** External ids of the user's Canvas tasks, for the read-only preview. */
export async function getCanvasTaskExternalIds(): Promise<Set<string> | null> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("external_id")
    .eq("user_id", user.id)
    .eq("source", "canvas")
    .not("external_id", "is", null);
  if (error) return null;
  return new Set(data.map((row) => row.external_id).filter((id) => id !== null));
}

export type StoredAssignmentPreference = {
  id: string;
  canvas_course_id: string;
  canvas_assignment_id: string;
  state: string;
  canvas_assignment_name: string | null;
};

/** The user's per-assignment decisions (ignored / included), newest first. */
export async function getCanvasAssignmentPreferences(): Promise<StoredAssignmentPreference[] | null> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("canvas_assignment_preferences")
    .select("id, canvas_course_id, canvas_assignment_id, state, canvas_assignment_name")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) return null;
  return data;
}

/**
 * set_canvas_assignment_preference (SECURITY INVOKER): records the decision and, for "ignored",
 * removes the caller's matching Campus task in the same transaction. Returns tasks removed.
 */
export async function setCanvasAssignmentPreference(
  courseId: string,
  assignmentId: string,
  state: "included" | "ignored",
  name: string | null,
): Promise<number | null> {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_canvas_assignment_preference", {
    p_canvas_course_id: courseId,
    p_canvas_assignment_id: assignmentId,
    p_state: state,
    p_canvas_assignment_name: name ?? undefined,
  });
  if (error || typeof data !== "number") return null;
  return data;
}

/** "Restaurar": removes one decision of the caller (RLS). Never creates or deletes a task. */
export async function deleteCanvasAssignmentPreference(preferenceId: string): Promise<boolean> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("canvas_assignment_preferences")
    .delete()
    .eq("id", preferenceId)
    .eq("user_id", user.id)
    .select("id");
  return !error && data.length === 1;
}

/** The caller's own task, for "Ignorar en TRAZA" (RLS: other users' tasks are invisible). */
export async function getCanvasTaskIdentity(taskId: string): Promise<{ source: string; externalId: string | null; title: string } | null> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase.from("tasks").select("source, external_id, title").eq("id", taskId).eq("user_id", user.id).maybeSingle();
  if (error || !data) return null;
  return { source: data.source, externalId: data.external_id, title: data.title };
}

/**
 * One call of sync_canvas_course_tasks (see its migration): upserts the caller's Canvas tasks for
 * a course they linked. The database pins every row to auth.uid() and to the linked project.
 */
export async function upsertCanvasCourseTasks(courseId: string, writes: CanvasTaskWrite[]): Promise<UpsertOutcome[] | null> {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sync_canvas_course_tasks", {
    p_canvas_course_id: courseId,
    p_assignments: writes,
  });
  if (error || !Array.isArray(data)) return null;
  return data;
}
