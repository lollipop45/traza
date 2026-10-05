import type { Tables } from "@/lib/supabase/database.types";
import type { InboxTask } from "@/lib/tasks/types";

/** A row of `public.inbox_items` (ideas and notes), exactly as generated from the database. */
export type InboxItemRow = Tables<"inbox_items">;

/** Columns the Inbox reads: a deliberate projection of `InboxItemRow`. */
export type InboxCapture = Pick<InboxItemRow, "id" | "kind" | "title" | "content" | "project_id" | "source" | "created_at">;
export const INBOX_CAPTURE_COLUMNS = "id, kind, title, content, project_id, source, created_at";

/** Mirror the check constraints in 20261005165232_create_inbox_items.sql. */
export const CAPTURE_TITLE_MAX_LENGTH = 200;
export const CAPTURE_CONTENT_MAX_LENGTH = 10000;

/** Mirrors `inbox_items_kind_valid`: what the inbox_items table stores. */
export const CAPTURE_KINDS = ["idea", "note"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** What the composer can create. "task" goes to public.tasks, never to inbox_items. */
export const ENTRY_KINDS = ["task", "idea", "note"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export function isCaptureKind(value: unknown): value is CaptureKind {
  return typeof value === "string" && (CAPTURE_KINDS as readonly string[]).includes(value);
}

export function isEntryKind(value: unknown): value is EntryKind {
  return typeof value === "string" && (ENTRY_KINDS as readonly string[]).includes(value);
}

/**
 * One row of the Inbox feed, over two sources of truth. Each entry keeps its real database id and
 * says which table it lives in; nothing is copied between them.
 */
export type InboxEntry = InboxTaskEntry | InboxCaptureEntry;

export type InboxTaskEntry = {
  kind: "task";
  /** tasks.id */
  id: string;
  /** The real task row, as Home reads it; edited through the task actions. */
  task: InboxTask;
  createdAt: string;
  projectName: string | null;
};

export type InboxCaptureEntry = {
  kind: CaptureKind;
  /** inbox_items.id */
  id: string;
  title: string | null;
  content: string | null;
  projectId: string | null;
  projectName: string | null;
  source: string;
  createdAt: string;
};
