import { isValidISODate } from "@/lib/calendar/dates";
import { parseEventDescription, parseEventTimes, parseEventTitle, parseLocation } from "@/lib/calendar/validation";
import { CAPTURE_CONTENT_MAX_LENGTH, CAPTURE_TITLE_MAX_LENGTH } from "@/lib/inbox/types";
import { isTaskPriority } from "@/lib/tasks/types";
import { parseTitle } from "@/lib/tasks/validation";
import { charLength, isUuid, type Parsed } from "@/lib/validation";
import { isProposalType, type Proposal, type ProposalType } from "./types";

// One set of rules for a proposal's fields, used twice: when the model's answer is turned into
// proposals (lib/assistant/response.ts) and again, on the stored payload, when the user confirms
// (lib/assistant/confirm.ts). They reuse the same validators as the manual task/event/Inbox forms,
// so an AI-created record satisfies exactly what a hand-made one does. The database checks again
// in execute_assistant_action().

const DESCRIPTION_MAX_LENGTH = 2000;
/** Notes from the assistant are short; the Inbox itself allows longer ones. */
const AI_CAPTURE_CONTENT_MAX_LENGTH = Math.min(4000, CAPTURE_CONTENT_MAX_LENGTH);

const invalid = (error: string): { ok: false; error: string } => ({ ok: false, error });

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isTextOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** A real calendar date within the app's range, or an error. */
export function parseProposalDate(value: unknown, required: boolean): Parsed<string | null> {
  const raw = text(value);
  if (!raw) return required ? invalid("Falta la fecha.") : { ok: true, value: null };
  return isValidISODate(raw) && raw >= "2000-01-01" && raw <= "2100-12-31" ? { ok: true, value: raw } : invalid("La fecha no es válida.");
}

/**
 * Checks a payload (column names) for a proposal type and returns the normalised proposal.
 * `projectIds`: the user's own project ids; any other project_id is rejected.
 */
export function checkProposal(type: unknown, payload: unknown, projectIds: ReadonlySet<string>): Parsed<Proposal> {
  if (!isProposalType(type)) return invalid("Acción no admitida.");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return invalid("Acción no válida.");
  const p = payload as Record<string, unknown>;

  for (const key of ["title", "description", "location", "content", "due_date", "event_date", "start_time", "end_time", "priority", "project_id"]) {
    if (!isTextOrNull(p[key])) return invalid("Acción no válida.");
  }
  const projectId = text(p.project_id);
  if (projectId && (!isUuid(projectId) || !projectIds.has(projectId.toLowerCase()))) return invalid("No encuentro ese proyecto.");
  const project_id = projectId ? projectId.toLowerCase() : null;

  const description = text(p.description);
  if (description && charLength(description) > DESCRIPTION_MAX_LENGTH) return invalid("La descripción es demasiado larga.");

  switch (type as ProposalType) {
    case "create_task": {
      const title = parseTitle(typeof p.title === "string" ? p.title : "");
      if (!title.ok) return title;
      const due = parseProposalDate(p.due_date, false);
      if (!due.ok) return due;
      const priority = p.priority ?? "normal";
      if (!isTaskPriority(priority)) return invalid("La prioridad no es válida.");
      return { ok: true, value: { type: "create_task", payload: { title: title.value, description, due_date: due.value, priority, project_id } } };
    }
    case "create_event": {
      const title = parseEventTitle(typeof p.title === "string" ? p.title : "");
      if (!title.ok) return title;
      const date = parseProposalDate(p.event_date, true);
      if (!date.ok) return date;
      if (typeof p.all_day !== "boolean") return invalid("Acción no válida.");
      const times = parseEventTimes(p.all_day, text(p.start_time) ?? "", text(p.end_time) ?? "");
      if (!times.ok) return times;
      const location = parseLocation(text(p.location) ?? "");
      if (!location.ok) return location;
      const eventDescription = parseEventDescription(description ?? "");
      if (!eventDescription.ok) return eventDescription;
      return {
        ok: true,
        value: {
          type: "create_event",
          payload: { title: title.value, description: eventDescription.value, event_date: date.value!, ...times.value, location: location.value, project_id },
        },
      };
    }
    case "create_note":
    case "create_idea": {
      const title = text(p.title);
      const content = text(p.content);
      if (!title && !content) return invalid("La nota está vacía.");
      if (title && charLength(title) > CAPTURE_TITLE_MAX_LENGTH) return invalid("El título es demasiado largo.");
      if (content && charLength(content) > AI_CAPTURE_CONTENT_MAX_LENGTH) return invalid("La nota es demasiado larga.");
      return { ok: true, value: { type: type as "create_note" | "create_idea", payload: { title, content, project_id } } };
    }
  }
}
