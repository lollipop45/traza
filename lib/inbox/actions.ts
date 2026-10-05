"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { insertTask, revalidateTaskViews } from "@/lib/tasks/mutations";
import { isInboxItemId, parseCapture, parseCaptureDetails } from "./validation";

// Every mutation: verifies the session, validates its input here on the server, and relies on RLS
// for ownership. None accepts a user_id, source, external_id or timestamps: those columns are not
// writable by `authenticated` (column-scoped grants), so manual captures always get
// source = manual. A project_id must belong to the same user (owner-matching foreign keys).
// Errors become fixed Spanish messages and are never logged.

const INBOX_PATH = "/inbox";

export type InboxMutationResult = { ok: true } | { ok: false; error: string };

/**
 * Composer submission. A task goes to public.tasks through the same write path as Home quick
 * capture (no inbox_items row); an idea or note goes to public.inbox_items.
 */
export async function captureEntry(formData: FormData): Promise<InboxMutationResult> {
  await requireUser();
  const failed: InboxMutationResult = { ok: false, error: "No se ha podido guardar." };

  const parsed = parseCapture(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (parsed.value.kind === "task") {
    if (!(await insertTask(parsed.value.task))) return failed;
    revalidateTaskViews();
    return { ok: true };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("inbox_items").insert(parsed.value.item);
  if (error) return failed;

  revalidatePath(INBOX_PATH);
  return { ok: true };
}

export async function updateInboxItem(itemId: string, formData: FormData): Promise<InboxMutationResult> {
  await requireUser();
  const failed: InboxMutationResult = { ok: false, error: "No se ha podido actualizar." };
  if (!isInboxItemId(itemId)) return failed;

  const parsed = parseCaptureDetails(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();
  const { data, error } = await supabase.from("inbox_items").update(parsed.value).eq("id", itemId).select("id");
  // Zero rows: the item does not exist or belongs to someone else (filtered out by RLS).
  if (error || data.length === 0) return failed;

  revalidatePath(INBOX_PATH);
  return { ok: true };
}

export async function deleteInboxItem(itemId: string): Promise<InboxMutationResult> {
  await requireUser();
  const failed: InboxMutationResult = { ok: false, error: "No se ha podido eliminar." };
  if (!isInboxItemId(itemId)) return failed;

  const supabase = await createClient();
  const { data, error } = await supabase.from("inbox_items").delete().eq("id", itemId).select("id");
  if (error || data.length === 0) return failed;

  revalidatePath(INBOX_PATH);
  return { ok: true };
}
