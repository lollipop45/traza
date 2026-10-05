"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isProjectId, parseNewProject, parseProjectDetails } from "./validation";

// Every mutation: verifies the session, validates its input here on the server, and relies on RLS
// for ownership. None accepts a user_id, source or timestamps; those columns are not writable by
// `authenticated` (column-scoped grants). Errors become fixed Spanish messages, never logged.

const PROJECTS_PATH = "/projects";
const HOME_PATH = "/";
const CALENDAR_PATH = "/calendar";

export type ProjectMutationResult = { ok: true } | { ok: false; error: string };

function revalidateProjectViews() {
  revalidatePath(PROJECTS_PATH);
  // Home shows the active-project count, project names on tasks and the project choices.
  revalidatePath(HOME_PATH);
  // Calendar shows project names on events and deadlines, and offers projects for events.
  revalidatePath(CALENDAR_PATH);
}

/** Creates a project, then returns to the full index (the new project may not match a filter). */
export async function createProject(formData: FormData): Promise<ProjectMutationResult> {
  await requireUser();

  const parsed = parseNewProject(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();
  // progress, source, user_id and timestamps come from database defaults.
  const { error } = await supabase.from("projects").insert(parsed.value);
  if (error) return { ok: false, error: "No se ha podido crear el proyecto." };

  revalidateProjectViews();
  redirect(PROJECTS_PATH);
}

export async function updateProject(projectId: string, formData: FormData): Promise<ProjectMutationResult> {
  await requireUser();
  const failed: ProjectMutationResult = { ok: false, error: "No se ha podido actualizar el proyecto." };
  if (!isProjectId(projectId)) return failed;

  const parsed = parseProjectDetails(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();
  const { data, error } = await supabase.from("projects").update(parsed.value).eq("id", projectId).select("id");
  // Zero rows: the project does not exist or belongs to someone else (filtered out by RLS).
  if (error || data.length === 0) return failed;

  revalidateProjectViews();
  return { ok: true };
}

/** Deletes a project. Its tasks are kept: the database clears their project_id (ON DELETE SET NULL). */
export async function deleteProject(projectId: string): Promise<ProjectMutationResult> {
  await requireUser();
  const failed: ProjectMutationResult = { ok: false, error: "No se ha podido eliminar el proyecto." };
  if (!isProjectId(projectId)) return failed;

  const supabase = await createClient();
  const { data, error } = await supabase.from("projects").delete().eq("id", projectId).select("id");
  if (error || data.length === 0) return failed;

  revalidateProjectViews();
  return { ok: true };
}
