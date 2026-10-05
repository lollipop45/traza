import "server-only";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { sortProjects, withTaskCounts } from "./projects";
import {
  PROJECT_OPTION_COLUMNS,
  PROJECT_SUMMARY_COLUMNS,
  type ProjectOption,
  type ProjectWithCounts,
} from "./types";

// Server-side reads only. RLS already restricts rows to the owner; the explicit user_id filters
// match the (user_id, …) indexes and document intent. Errors are not logged: they can echo data.

export type ProjectIndexResult = { ok: true; projects: ProjectWithCounts[] } | { ok: false };

/**
 * Every project of the signed-in user in index order, with task counts derived from
 * `public.tasks` (only `project_id` and `status` are read). Filtering by status happens on
 * this list, so the filter counts and the visual numbers always agree.
 */
export async function getProjectIndex(): Promise<ProjectIndexResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const [projects, tasks] = await Promise.all([
    supabase.from("projects").select(PROJECT_SUMMARY_COLUMNS).eq("user_id", user.id),
    supabase.from("tasks").select("project_id, status").eq("user_id", user.id).not("project_id", "is", null),
  ]);

  if (projects.error || tasks.error) return { ok: false };
  return { ok: true, projects: sortProjects(withTaskCounts(projects.data, tasks.data)) };
}

export type ProjectOptionsResult = { ok: true; projects: ProjectOption[] } | { ok: false };

/**
 * The signed-in user's projects as name + status, alphabetically: names for task rows, choices
 * for task forms and the Home active-project count. Includes archived projects (for names).
 */
export async function getProjectOptions(): Promise<ProjectOptionsResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_OPTION_COLUMNS)
    .eq("user_id", user.id)
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) return { ok: false };
  return { ok: true, projects: data };
}
