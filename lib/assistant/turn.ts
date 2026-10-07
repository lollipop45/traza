import type { AiDiagnostic, AiProvider, AiTurn, ProviderStage } from "@/lib/ai/types";
import { charLength } from "@/lib/validation";
import { buildAssistantContext, type ContextSource } from "./context";
import { actionTypeLabels } from "./labels";
import { REPLY_SCHEMA, systemPrompt } from "./prompt";
import { analyzeReply, replyText, type ReplyStage } from "./response";
import { PROPOSAL_ITEM, type MessageRole, type Proposal, type ProposalState, type ProposalType } from "./types";

// One turn of the conversation, independent of Next.js, Supabase and the provider (all injected,
// so tests use a fake provider and an in-memory store):
//   1. validate the text; 2. the conversation must be the user's own (or a new one);
//   3. read the bounded context; 4. store the user's message; 5. ask the model (server-side);
//   6. validate its JSON; 7. store the visible answer and its proposals as `proposed`.
// Nothing here creates a task, event or note: that only happens on confirmation (confirm.ts).
// If the provider fails, the user's message stays stored, TRAZA data is untouched, and the error is
// a fixed Spanish sentence (provider messages are never shown or logged).

export const USER_MESSAGE_MAX_LENGTH = 2000;
/** Earlier messages sent back to the model for continuity. */
export const HISTORY_LIMIT = 12;
const HISTORY_ENTRY_MAX = 1500;

export type HistoryEntry = {
  role: MessageRole;
  content: string;
  actions: { type: ProposalType; title: string | null; state: ProposalState }[];
};

/** Supabase access as the signed-in user (see store.ts). */
export type AssistantStore = {
  /** The given conversation if it is the user's own; otherwise (null) a new one. Null on error. */
  resolveConversation(conversationId: string | null, title: string): Promise<string | null>;
  /** The latest messages of the conversation, oldest first. */
  loadHistory(conversationId: string, limit: number): Promise<HistoryEntry[] | null>;
  addUserMessage(conversationId: string, content: string): Promise<boolean>;
  /** The visible answer and its proposals, atomically (add_assistant_reply). */
  addReply(conversationId: string, content: string, proposals: Proposal[]): Promise<boolean>;
};

export type TurnDeps = {
  store: AssistantStore;
  loadContext: () => Promise<ContextSource | null>;
  /** Null when no API key is configured. */
  provider: AiProvider | null;
  now: () => Date;
};

/**
 * DEVELOPMENT diagnostics of one turn: which stage failed (a fixed vocabulary) and safe provider
 * metadata (HTTP status, finish reason, candidate and token counts, discard counts). Never the
 * prompt, the user's data, the model's text or any provider body.
 */
export type TurnDiagnostic = Omit<AiDiagnostic, "stage"> & {
  stage: ProviderStage | ReplyStage | "unsupported_action" | "malformed_action" | null;
  discards?: { unsupported: number; malformed: number };
};

export type TurnResult =
  | { ok: true; conversationId: string; diagnostic?: TurnDiagnostic }
  | { ok: false; error: string; conversationId: string | null; diagnostic?: TurnDiagnostic };

export const TURN_ERRORS = {
  empty: "Escribe una pregunta o una instrucción.",
  tooLong: `El mensaje no puede superar los ${USER_MESSAGE_MAX_LENGTH} caracteres.`,
  notConfigured: "El asistente no está configurado en el servidor.",
  storage: "No se ha podido guardar el mensaje.",
  context: "No se han podido leer tus datos de TRAZA.",
  unavailable: "El asistente no está disponible en este momento.",
  busy: "El asistente está recibiendo demasiadas peticiones. Inténtalo dentro de un momento.",
  invalid: "El asistente no ha dado una respuesta válida. Inténtalo de nuevo.",
  reply: "No se ha podido guardar la respuesta del asistente.",
} as const;

const STATE_LABELS: Record<ProposalState, string> = { proposed: "sin confirmar", executed: "confirmada", dismissed: "descartada" };

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** Earlier messages as model turns. Proposals are summarised in words (no ids). */
export function historyTurns(history: HistoryEntry[]): AiTurn[] {
  return history.map((entry) => {
    const proposals = entry.actions.map((action) => `${actionTypeLabels[PROPOSAL_ITEM[action.type]]} «${action.title ?? "sin título"}» (${STATE_LABELS[action.state]})`);
    const text = proposals.length > 0 ? `${clip(entry.content, HISTORY_ENTRY_MAX)}\n[Propuestas: ${proposals.join("; ")}]` : clip(entry.content, HISTORY_ENTRY_MAX);
    return { role: entry.role === "user" ? "user" : "model", text };
  });
}

/** First words of the first message, as the conversation's label. */
export function conversationTitle(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return clip(single, 80);
}

export async function runAssistantTurn(deps: TurnDeps, input: { conversationId: string | null; text: unknown }): Promise<TurnResult> {
  const text = typeof input.text === "string" ? input.text.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) return { ok: false, error: TURN_ERRORS.empty, conversationId: input.conversationId };
  if (charLength(text) > USER_MESSAGE_MAX_LENGTH) return { ok: false, error: TURN_ERRORS.tooLong, conversationId: input.conversationId };
  // Without a provider nothing is stored: there would be no answer.
  if (!deps.provider) return { ok: false, error: TURN_ERRORS.notConfigured, conversationId: input.conversationId };

  const conversationId = await deps.store.resolveConversation(input.conversationId, conversationTitle(text));
  if (!conversationId) return { ok: false, error: TURN_ERRORS.storage, conversationId: null };

  const [history, source] = await Promise.all([deps.store.loadHistory(conversationId, HISTORY_LIMIT), deps.loadContext()]);
  if (!history) return { ok: false, error: TURN_ERRORS.storage, conversationId };
  if (!source) return { ok: false, error: TURN_ERRORS.context, conversationId };

  if (!(await deps.store.addUserMessage(conversationId, text))) return { ok: false, error: TURN_ERRORS.storage, conversationId };

  const built = buildAssistantContext(source, deps.now(), text);
  const result = await deps.provider.generate({
    system: systemPrompt(built.context),
    turns: [...historyTurns(history), { role: "user", text }],
    schema: REPLY_SCHEMA,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.kind === "rate-limited" ? TURN_ERRORS.busy : result.kind === "invalid-response" ? TURN_ERRORS.invalid : TURN_ERRORS.unavailable,
      conversationId,
      diagnostic: { ...result.diagnostic, stage: result.diagnostic?.stage ?? null },
    };
  }

  const analyzed = analyzeReply(result.text, built);
  if (!analyzed.ok) return { ok: false, error: TURN_ERRORS.invalid, conversationId, diagnostic: { ...result.diagnostic, stage: analyzed.stage } };
  const reply = analyzed.reply;
  const { unsupported, malformed } = reply.discards;
  const diagnostic: TurnDiagnostic = {
    ...result.diagnostic,
    stage: unsupported > 0 ? "unsupported_action" : malformed > 0 ? "malformed_action" : null,
    ...(reply.discarded > 0 ? { discards: reply.discards } : {}),
  };

  if (!(await deps.store.addReply(conversationId, replyText(reply), reply.proposals))) return { ok: false, error: TURN_ERRORS.reply, conversationId, diagnostic };
  return { ok: true, conversationId, diagnostic };
}
