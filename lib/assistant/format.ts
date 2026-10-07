import { daysBetween, formatDayHeading, formatDayMonth } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { weekdayOf } from "./clock";
import { actionTypeLabels } from "./labels";
import { checkProposal } from "./proposals";
import { PROPOSAL_ITEM, isProposalType, type ActionField, type ActionView, type ProposalState } from "./types";

// Spanish presentation of stored proposals, built on the server. Pure (tested). Shows exactly what
// confirming would create, with the date resolved and spelled out ("jueves 8 OCT · mañana").

/** "hoy" / "mañana" / "ayer", or null. */
export function relativeDay(date: ISODate, today: ISODate): string | null {
  const diff = daysBetween(today, date);
  return diff === 0 ? "hoy" : diff === 1 ? "mañana" : diff === -1 ? "ayer" : null;
}

/** "jueves 8 OCT" */
export function shortDay(date: ISODate): string {
  return `${weekdayOf(date)} ${formatDayMonth(date)}`;
}

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

const PRIORITY_LABELS: Record<string, string> = { high: "Alta", low: "Baja" };

/**
 * A stored proposal as the screen shows it. The payload is re-checked with the confirmation rules
 * (projects: any id the user owns, i.e. those in `projectNames`); null when it is not displayable.
 */
export function actionView(
  stored: { id: string; action_type: string; payload: unknown; state: string },
  projectNames: ReadonlyMap<string, string>,
  today: ISODate,
): ActionView | null {
  if (!isProposalType(stored.action_type)) return null;
  // A project deleted since the proposal is still displayed (as no project); confirming it is
  // refused by confirm.ts, which checks ownership strictly.
  const storedProject = (stored.payload as { project_id?: unknown } | null)?.project_id;
  const known = new Set([...projectNames.keys(), ...(typeof storedProject === "string" ? [storedProject.toLowerCase()] : [])]);
  const checked = checkProposal(stored.action_type, stored.payload, known);
  if (!checked.ok) return null;
  const proposal = checked.value;
  const kind = PROPOSAL_ITEM[proposal.type];
  const label = actionTypeLabels[kind];
  const state: ProposalState = stored.state === "executed" || stored.state === "dismissed" ? stored.state : "proposed";
  const fields: ActionField[] = [];
  const project = proposal.payload.project_id ? projectNames.get(proposal.payload.project_id) : null;
  const when = (date: ISODate) => [formatDayHeading(date), relativeDay(date, today)].filter(Boolean).join(" · ");

  let title: string;
  let summary: string;
  switch (proposal.type) {
    case "create_task": {
      const { payload } = proposal;
      title = payload.title;
      fields.push({ term: "Fecha", value: payload.due_date ? when(payload.due_date) : "Sin fecha" });
      if (PRIORITY_LABELS[payload.priority]) fields.push({ term: "Prioridad", value: PRIORITY_LABELS[payload.priority] });
      if (payload.description) fields.push({ term: "Detalle", value: clip(payload.description, 160) });
      summary = [label, payload.due_date ? (relativeDay(payload.due_date, today) ?? shortDay(payload.due_date)) : "sin fecha"].join(" · ");
      break;
    }
    case "create_event": {
      const { payload } = proposal;
      title = payload.title;
      const time = payload.all_day ? "Todo el día" : `${payload.start_time}${payload.end_time ? ` – ${payload.end_time}` : ""}`;
      fields.push({ term: "Fecha", value: when(payload.event_date) }, { term: "Hora", value: time, mono: !payload.all_day });
      if (payload.location) fields.push({ term: "Lugar", value: payload.location });
      if (payload.description) fields.push({ term: "Detalle", value: clip(payload.description, 160) });
      summary = [label, shortDay(payload.event_date), payload.all_day ? "todo el día" : payload.start_time].join(" · ");
      break;
    }
    default: {
      const { payload } = proposal;
      title = payload.title ?? clip(payload.content ?? "", 80);
      if (payload.title && payload.content) fields.push({ term: "Texto", value: clip(payload.content, 160) });
      summary = label;
    }
  }
  if (project) fields.push({ term: "Proyecto", value: project });
  return { id: stored.id, kind, title, summary, fields, state };
}
