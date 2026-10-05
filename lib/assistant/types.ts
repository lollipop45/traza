import type { ISODate, TimeOfDay } from "@/lib/calendar/types";
import type { ProjectId } from "@/lib/projects/types";

export type ProposedActionType = "task" | "event" | "note" | "project";

/**
 * One structured action the assistant proposes from natural language. Shaped so an LLM can later
 * return a JSON array of these; nothing is created until the user confirms.
 */
export type ProposedAction = {
  id: string;
  type: ProposedActionType;
  title: string;
  description?: string;
  date?: ISODate;
  startTime?: TimeOfDay;
  endTime?: TimeOfDay;
  projectId?: ProjectId;
  location?: string;
  /** Local date-time for a reminder, e.g. "2026-10-07T09:00". */
  reminder?: string;
  source: "ai";
};

export type MessageRole = "user" | "assistant";

export type AssistantMessage = {
  id: string;
  role: MessageRole;
  content: string;
  /** Local date-time, e.g. "2026-10-05T10:42". */
  createdAt: string;
  proposedActions?: ProposedAction[];
  /** Short follow-up instructions the user can pick instead of typing. */
  suggestions?: string[];
};
