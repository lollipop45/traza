import { charLength } from "@/lib/validation";
import { MAX_PROPOSALS } from "./prompt";
import { checkProposal } from "./proposals";
import { isProposalType, type Proposal } from "./types";

// Turns the model's JSON text into a visible message plus validated proposals. Nothing the model
// returns is trusted: the JSON must have the expected shape, each action is rebuilt field by field
// (unknown fields such as user_id or a project UUID are simply never read), project references must
// be ones TRAZA handed out for this request, and every field passes the same validators as the
// manual forms. An invalid action is discarded (and counted), never "repaired".

export const MESSAGE_MAX_LENGTH = 4000;

export type ParsedReply = {
  message: string;
  proposals: Proposal[];
  discarded: number;
  /** Why actions were discarded (development diagnostics): an unknown type, or invalid fields. */
  discards: { unsupported: number; malformed: number };
};

/** Why a whole answer was rejected: not JSON at all, or JSON without the expected shape. */
export type ReplyStage = "invalid_json" | "schema_validation";

type Refs = { projectRefs: ReadonlyMap<string, string>; projectIds: ReadonlySet<string> };

function optional(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One model action → a validated proposal, or an error (`unsupported` for an unknown type). */
export function toProposal(raw: unknown, refs: Refs): { ok: true; proposal: Proposal } | { ok: false; error: string; unsupported?: true } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "Acción no válida." };
  const action = raw as Record<string, unknown>;
  if (!isProposalType(action.type)) return { ok: false, error: "Acción no admitida.", unsupported: true };

  // A project only through a reference TRAZA supplied for this request.
  const ref = optional(action.projectRef);
  let projectId: string | null = null;
  if (ref) {
    const resolved = refs.projectRefs.get(ref.toUpperCase());
    if (!resolved) return { ok: false, error: "No encuentro ese proyecto." };
    projectId = resolved;
  }

  const date = optional(action.date);
  const payload: Record<string, unknown> =
    action.type === "create_task"
      ? { title: action.title, description: optional(action.description), due_date: date, priority: optional(action.priority) ?? "normal", project_id: projectId }
      : action.type === "create_event"
        ? {
            title: action.title,
            description: optional(action.description),
            event_date: date,
            start_time: optional(action.startTime),
            end_time: optional(action.endTime),
            all_day: typeof action.allDay === "boolean" ? action.allDay : !optional(action.startTime),
            location: optional(action.location),
            project_id: projectId,
          }
        : { title: optional(action.title), content: optional(action.content) ?? optional(action.description), project_id: projectId };

  const checked = checkProposal(action.type, payload, refs.projectIds);
  return checked.ok ? { ok: true, proposal: checked.value } : checked;
}

/** The validated answer, or the stage at which the whole answer was rejected. */
export function analyzeReply(text: string, refs: Refs): { ok: true; reply: ParsedReply } | { ok: false; stage: ReplyStage } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, stage: "invalid_json" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, stage: "schema_validation" };
  const { message, actions } = body as Record<string, unknown>;
  if (typeof message !== "string" || !message.trim() || charLength(message.trim()) > MESSAGE_MAX_LENGTH) return { ok: false, stage: "schema_validation" };
  if (actions !== undefined && actions !== null && !Array.isArray(actions)) return { ok: false, stage: "schema_validation" };

  const proposals: Proposal[] = [];
  const discards = { unsupported: 0, malformed: 0 };
  for (const raw of (actions ?? []) as unknown[]) {
    const result = proposals.length < MAX_PROPOSALS ? toProposal(raw, refs) : null;
    if (result?.ok) proposals.push(result.proposal);
    else if (result && "unsupported" in result) discards.unsupported++;
    else discards.malformed++;
  }
  return { ok: true, reply: { message: message.trim(), proposals, discarded: discards.unsupported + discards.malformed, discards } };
}

/** Null when the text is not the expected JSON (the whole answer is then rejected). */
export function parseReply(text: string, refs: Refs): ParsedReply | null {
  const analyzed = analyzeReply(text, refs);
  return analyzed.ok ? analyzed.reply : null;
}

/** The stored visible text: the model's message, plus a note when proposals were discarded. */
export function replyText(reply: ParsedReply): string {
  if (reply.discarded === 0) return reply.message;
  const note =
    reply.discarded === 1
      ? "(Una propuesta no era válida y se ha descartado: revisa la fecha, la hora o el proyecto.)"
      : `(${reply.discarded} propuestas no eran válidas y se han descartado: revisa fechas, horas o proyectos.)`;
  return `${reply.message}\n\n${note}`;
}
