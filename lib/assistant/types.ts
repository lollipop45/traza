import type { ISODate, TimeOfDay } from "@/lib/calendar/types";
import type { TaskPriority } from "@/lib/tasks/types";

/** What a proposal creates; also the icon/label key in the UI. */
export type ProposedActionType = "task" | "event" | "note" | "idea";

/** Mirrors assistant_actions_type_valid. Only creations: the assistant never updates or deletes. */
export const PROPOSAL_TYPES = ["create_task", "create_event", "create_note", "create_idea"] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export function isProposalType(value: unknown): value is ProposalType {
  return typeof value === "string" && (PROPOSAL_TYPES as readonly string[]).includes(value);
}

export const PROPOSAL_ITEM: Record<ProposalType, ProposedActionType> = {
  create_task: "task",
  create_event: "event",
  create_note: "note",
  create_idea: "idea",
};

/**
 * The validated fields of a proposal, named like the target table's columns. This is exactly what
 * assistant_actions.payload stores and what execute_assistant_action() reads. project_id is always
 * one of the user's own projects, resolved by TRAZA (never an id from the model).
 */
export type TaskPayload = {
  title: string;
  description: string | null;
  due_date: ISODate | null;
  priority: TaskPriority;
  project_id: string | null;
};

export type EventPayload = {
  title: string;
  description: string | null;
  event_date: ISODate;
  start_time: TimeOfDay | null;
  end_time: TimeOfDay | null;
  all_day: boolean;
  location: string | null;
  project_id: string | null;
};

export type CapturePayload = {
  title: string | null;
  content: string | null;
  project_id: string | null;
};

export type Proposal =
  | { type: "create_task"; payload: TaskPayload }
  | { type: "create_event"; payload: EventPayload }
  | { type: "create_note" | "create_idea"; payload: CapturePayload };

/** Mirrors assistant_actions_state_valid. */
export type ProposalState = "proposed" | "executed" | "dismissed";

export type MessageRole = "user" | "assistant";

// ---------------------------------------------------------------------------
// What the Assistant screen renders (built on the server; no other ids than the proposal's own)
// ---------------------------------------------------------------------------

/** One labelled line of a proposal ("Fecha", "Hora", …). */
export type ActionField = { term: string; value: string; mono?: boolean };

export type ActionView = {
  /** assistant_actions.id: the database-generated key used to confirm or dismiss it. */
  id: string;
  kind: ProposedActionType;
  title: string;
  /** "Evento · jueves 8 OCT · 10:00" */
  summary: string;
  fields: ActionField[];
  state: ProposalState;
};

export type MessageView = {
  id: string;
  role: MessageRole;
  content: string;
  /** ISO timestamp. */
  createdAt: string;
  /** "10:42", Atlantic/Canary. */
  time: string;
  actions: ActionView[];
};
