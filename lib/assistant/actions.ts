"use server";

import { revalidatePath } from "next/cache";
import { aiDiagnosticLabels, getAiProvider } from "@/lib/ai/provider";
import { requireUser } from "@/lib/auth/session";
import { revalidateTaskViews } from "@/lib/tasks/mutations";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";
import { confirmProposals, confirmSummary } from "./confirm";
import { createAssistantStore, createConfirmDeps, dismissProposal, loadContextSource } from "./store";
import { diagnosticLine } from "./diagnostics";
import { runAssistantTurn, type TurnResult } from "./turn";

// Server Actions for the Assistant. Each verifies the TRAZA session (Server Actions also reject
// cross-origin requests). The browser sends only its text, a conversation id and proposal ids;
// never a user id, a project id for a proposal, or anything the model produced. The AI provider is
// called here on the server; its key never leaves the server. Errors are fixed Spanish sentences.

const ASSISTANT_PATH = "/assistant";

export type AssistantActionResult = { ok: true; message?: string } | { ok: false; error: string };

const diagnostics = () => process.env.NODE_ENV !== "production";

/** "Enviar": stores the message, asks the model with the user's real context, stores its answer. */
export async function sendAssistantMessage(conversationId: string | null, text: string): Promise<AssistantActionResult> {
  const user = await requireUser();
  let result: TurnResult;
  try {
    result = await runAssistantTurn(
      {
        store: createAssistantStore(user.id),
        loadContext: () => loadContextSource(user.id),
        provider: getAiProvider(),
        now: () => new Date(),
      },
      { conversationId: isUuid(conversationId) ? conversationId : null, text },
    );
  } catch {
    // Discarded, not logged: it could carry request or provider details.
    result = { ok: false, error: "El asistente no está disponible en este momento.", conversationId: null, diagnostic: { stage: "unexpected_response" } };
  }
  revalidatePath(ASSISTANT_PATH);

  // Development only: one line of safe metadata per request (provider, stage, HTTP status, attempts,
  // elapsed time, finish reason, counts, model) to the server console and, on failure, the stage
  // after the message. Production shows the fixed sentence only.
  if (diagnostics()) {
    const labels = aiDiagnosticLabels();
    const line = diagnosticLine(result.diagnostic, labels.model, labels.provider);
    console.warn(`TRAZA assistant diagnostic: ${line}`);
    if (!result.ok && result.diagnostic?.stage) return { ok: false, error: `${result.error} (Diagnóstico: ${result.diagnostic.stage})` };
  }
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** "Confirmar": creates the proposals' records (source = ai), each at most once. */
export async function confirmAssistantActions(actionIds: string[]): Promise<AssistantActionResult> {
  const user = await requireUser();
  const result = await confirmProposals(createConfirmDeps(user.id), actionIds);
  revalidatePath(ASSISTANT_PATH);
  if (!result.ok) return result;
  if (result.results.some((entry) => entry.outcome === "executed")) {
    revalidateTaskViews(); // Home, Projects, Calendar, Inbox
  }
  const summary = confirmSummary(result.results);
  return result.results.every((entry) => entry.outcome === "executed" || entry.outcome === "already-executed") ? { ok: true, message: summary } : { ok: false, error: summary };
}

/** "Descartar": the proposal can no longer be confirmed. */
export async function dismissAssistantAction(actionId: string): Promise<AssistantActionResult> {
  await requireUser();
  if (!isUuid(actionId)) return { ok: false, error: "La acción no es válida." };
  const state = await dismissProposal(actionId);
  revalidatePath(ASSISTANT_PATH);
  if (state === "dismissed") return { ok: true };
  return { ok: false, error: state === "executed" ? "Esa acción ya está creada." : "No se ha podido descartar." };
}

/** "Nueva conversación": a fresh, empty conversation (unless the latest one is still empty). */
export async function startAssistantConversation(): Promise<AssistantActionResult> {
  const user = await requireUser();
  const supabase = await createClient();
  const latest = await supabase.from("assistant_conversations").select("id").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) return { ok: false, error: "No se ha podido empezar una conversación." };
  if (latest.data) {
    const used = await supabase.from("assistant_messages").select("id", { count: "exact", head: true }).eq("conversation_id", latest.data.id);
    if (used.error) return { ok: false, error: "No se ha podido empezar una conversación." };
    if ((used.count ?? 0) === 0) return { ok: true };
  }
  const { error } = await supabase.from("assistant_conversations").insert({});
  if (error) return { ok: false, error: "No se ha podido empezar una conversación." };
  revalidatePath(ASSISTANT_PATH);
  return { ok: true };
}
