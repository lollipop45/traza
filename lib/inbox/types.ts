import type { ISODate } from "@/lib/calendar/types";

export type InboxItemType = "task" | "idea" | "note";

/** Where a capture came from. Only "manual" exists today; "canvas" and "ai" are reserved. */
export type InboxSource = "manual" | "canvas" | "ai";

export type InboxItem = {
  id: string;
  type: InboxItemType;
  title: string;
  /** Free-form body for longer notes and ideas. */
  content?: string;
  /** Local date-time of capture, e.g. "2026-10-05T09:40". */
  createdAt: string;
  /** Only meaningful for tasks. */
  dueDate?: ISODate;
  /** Display label of the project, subject or area the capture is filed under. */
  project?: string;
  /** Stable project reference, when the capture belongs to a tracked project. */
  projectId?: string;
  tags: string[];
  source: InboxSource;
};
