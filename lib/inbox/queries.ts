import "server-only";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { INBOX_CAPTURE_COLUMNS, type InboxCapture } from "./types";

// Server-side reads only. RLS already restricts rows to the owner; the explicit user_id filter
// matches the (user_id, created_at desc) index and documents intent. Errors are not logged.
// Tasks for the Inbox are read through lib/tasks/queries.ts (getRecentTasks), their own table.

/** Enough for a personal capture feed; the newest are always included. */
const CAPTURE_LIMIT = 200;

export type InboxCapturesResult = { ok: true; captures: InboxCapture[] } | { ok: false };

/** The signed-in user's ideas and notes, newest first. */
export async function getRecentCaptures(): Promise<InboxCapturesResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("inbox_items")
    .select(INBOX_CAPTURE_COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(CAPTURE_LIMIT);

  if (error) return { ok: false };
  return { ok: true, captures: data };
}
