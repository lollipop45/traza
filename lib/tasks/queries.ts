import "server-only";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { ISODate } from "@/lib/calendar/types";
import { DEADLINE_TASK_COLUMNS, HOME_TASK_COLUMNS, type DeadlineTask, type HomeTask } from "./types";

/** Enough for a personal list; pending tasks sort first, so only old completed ones fall off. */
const HOME_TASK_LIMIT = 200;

export type HomeTasksResult = { ok: true; tasks: HomeTask[] } | { ok: false };

/**
 * The signed-in user's tasks for Home, ordered:
 *   1. pending before done ('pending' > 'done', so status descending),
 *   2. due date ascending, undated last,
 *   3. newest first, then id, as a stable tie-breaker.
 * RLS already restricts rows to the owner; the explicit user_id filter matches the
 * (user_id, due_date) index and documents intent.
 */
export async function getHomeTasks(): Promise<HomeTasksResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tasks")
    .select(HOME_TASK_COLUMNS)
    .eq("user_id", user.id)
    .order("status", { ascending: false })
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(HOME_TASK_LIMIT);

  // Not logged: database errors can echo row data.
  if (error) return { ok: false };
  return { ok: true, tasks: data };
}

export type DeadlineTasksResult = { ok: true; tasks: DeadlineTask[] } | { ok: false };

/** Tasks (pending and done) due between two dates, inclusive: the calendar's deadline items. */
export async function getTasksDueBetween(from: ISODate, to: ISODate): Promise<DeadlineTasksResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tasks")
    .select(DEADLINE_TASK_COLUMNS)
    .eq("user_id", user.id)
    .gte("due_date", from)
    .lte("due_date", to)
    .order("due_date", { ascending: true })
    .order("id", { ascending: true });

  if (error) return { ok: false };
  return { ok: true, tasks: data };
}

/** Enough for "Próximas entregas"; overdue first, so the earliest are always included. */
const UPCOMING_DEADLINE_LIMIT = 50;

/** Pending tasks with a due date (overdue included), earliest first. Completed tasks never appear. */
export async function getPendingDeadlineTasks(): Promise<DeadlineTasksResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tasks")
    .select(DEADLINE_TASK_COLUMNS)
    .eq("user_id", user.id)
    .eq("status", "pending")
    .not("due_date", "is", null)
    .order("due_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(UPCOMING_DEADLINE_LIMIT);

  if (error) return { ok: false };
  return { ok: true, tasks: data };
}
