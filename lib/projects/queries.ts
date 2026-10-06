import "server-only";
import { requireUser } from "@/lib/auth/session";
import { currentISODate } from "@/lib/calendar/dates";
import { getCanvasLinkedProjectIds } from "@/lib/canvas/links";
import { createClient } from "@/lib/supabase/server";
import { nextMilestones, sortProjects, withTaskCounts } from "./projects";
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
 * Every project of the signed-in user in index order, with task counts and the next milestone
 * derived from `public.tasks` and `public.calendar_events` (never stored on the project).
 * Filtering by status happens on this list, so the filter counts and the visual numbers always agree.
 */
export async function getProjectIndex(): Promise<ProjectIndexResult> {
  const user = await requireUser();
  const supabase = await createClient();
  const today = currentISODate();

  const [projects, tasks, events, campusLinked] = await Promise.all([
    supabase.from("projects").select(PROJECT_SUMMARY_COLUMNS).eq("user_id", user.id),
    supabase.from("tasks").select("id, project_id, status, due_date, title").eq("user_id", user.id).not("project_id", "is", null),
    supabase
      .from("calendar_events")
      .select("id, project_id, event_date, title")
      .eq("user_id", user.id)
      .not("project_id", "is", null)
      .gte("event_date", today),
    // Optional decoration: if the links cannot be read, projects still render (without CAMPUS labels).
    getCanvasLinkedProjectIds(),
  ]);

  if (projects.error || tasks.error || events.error) return { ok: false };
  const milestones = nextMilestones(tasks.data, events.data, today);
  return { ok: true, projects: sortProjects(withTaskCounts(projects.data, tasks.data, campusLinked ?? new Set(), milestones)) };
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
