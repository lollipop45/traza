import { isUuid } from "@/lib/validation";
import { checkProposal } from "./proposals";

// Confirmation: the ONLY path from a proposal to a real task / event / note. For each proposal id
// (database-generated; never one from the model):
//   1. it must be one of the signed-in user's proposals (RLS) and still `proposed`;
//   2. its stored payload is validated again with the same rules as the forms, and its project
//      must still be one of the user's own;
//   3. execute_assistant_action() creates the record with source = 'ai' and marks the proposal
//      executed in one transaction, locking the row: a repeated confirmation (double click,
//      refresh, two tabs) returns "already-executed" and creates nothing.
// Each proposal is independent: results are reported one by one, so a partial failure says exactly
// what was created and what was not.

export const MAX_CONFIRM = 10;

export type StoredAction = { id: string; action_type: string; payload: unknown; state: string };

export type ConfirmDeps = {
  /** The user's own proposals among these ids (RLS). Null on error. */
  loadActions(ids: string[]): Promise<StoredAction[] | null>;
  /** The user's own project ids. Null on error. */
  loadProjectIds(): Promise<Set<string> | null>;
  /** execute_assistant_action(id). */
  execute(id: string): Promise<{ ok: true; outcome: "executed" | "already-executed" } | { ok: false }>;
};

export type ConfirmOutcome = "executed" | "already-executed" | "dismissed" | "invalid" | "not-found" | "failed";
export type ConfirmResult = { ok: true; results: { id: string; outcome: ConfirmOutcome }[] } | { ok: false; error: string };

export async function confirmProposals(deps: ConfirmDeps, ids: unknown): Promise<ConfirmResult> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CONFIRM || !ids.every(isUuid)) return { ok: false, error: "Las acciones no son válidas." };
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];

  const [actions, projectIds] = await Promise.all([deps.loadActions(unique), deps.loadProjectIds()]);
  if (!actions || !projectIds) return { ok: false, error: "No se han podido leer las acciones." };
  const byId = new Map(actions.map((action) => [action.id.toLowerCase(), action]));

  const results: { id: string; outcome: ConfirmOutcome }[] = [];
  for (const id of unique) {
    const action = byId.get(id);
    if (!action) {
      results.push({ id, outcome: "not-found" });
      continue;
    }
    if (action.state === "executed") {
      results.push({ id, outcome: "already-executed" });
      continue;
    }
    if (action.state !== "proposed") {
      results.push({ id, outcome: "dismissed" });
      continue;
    }
    if (!checkProposal(action.action_type, action.payload, projectIds).ok) {
      results.push({ id, outcome: "invalid" });
      continue;
    }
    const executed = await deps.execute(id);
    results.push({ id, outcome: executed.ok ? executed.outcome : "failed" });
  }
  return { ok: true, results };
}

/** "2 acciones creadas." / "1 creada · 1 no se ha podido crear." */
export function confirmSummary(results: { outcome: ConfirmOutcome }[]): string {
  const created = results.filter((result) => result.outcome === "executed" || result.outcome === "already-executed").length;
  const failed = results.length - created;
  if (failed === 0) return created === 1 ? "Acción creada." : `${created} acciones creadas.`;
  if (created === 0) return failed === 1 ? "No se ha podido crear la acción. No se ha cambiado nada." : `No se ha podido crear ninguna de las ${failed} acciones. No se ha cambiado nada.`;
  return `${created} ${created === 1 ? "creada" : "creadas"} · ${failed} no se ${failed === 1 ? "ha" : "han"} podido crear (revisa la fecha o el proyecto).`;
}
