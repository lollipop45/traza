import "server-only";
import { addDays, currentISODate } from "@/lib/calendar/dates";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";
import type { ConfirmDeps } from "./confirm";
import type { ContextSource } from "./context";
import type { AssistantStore, HistoryEntry } from "./turn";
import { isProposalType, type MessageRole, type ProposalState } from "./types";

// Supabase access for the assistant, as the signed-in user (publishable key + session; RLS limits
// every statement to their own rows; no service role). Server-only; callers must have verified the
// session. Errors are not logged: they can echo data.

function payloadTitle(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const title = (payload as Record<string, unknown>).title;
  return typeof title === "string" ? title : null;
}

export function createAssistantStore(userId: string): AssistantStore {
  return {
    async resolveConversation(conversationId, title) {
      const supabase = await createClient();
      if (isUuid(conversationId)) {
        const { data, error } = await supabase.from("assistant_conversations").select("id").eq("id", conversationId).eq("user_id", userId).maybeSingle();
        if (error) return null;
        if (data) return data.id;
      }
      const { data, error } = await supabase.from("assistant_conversations").insert({ title: title || null }).select("id").single();
      return error ? null : data.id;
    },

    async loadHistory(conversationId, limit) {
      const supabase = await createClient();
      const messages = await supabase
        .from("assistant_messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (messages.error) return null;
      const ids = messages.data.map((message) => message.id);
      const actions = ids.length
        ? await supabase.from("assistant_actions").select("message_id, action_type, payload, state, position").in("message_id", ids).order("position")
        : { data: [], error: null };
      if (actions.error) return null;
      return [...messages.data].reverse().map(
        (message): HistoryEntry => ({
          role: message.role as MessageRole,
          content: message.content,
          actions: actions.data
            .filter((action) => action.message_id === message.id && isProposalType(action.action_type))
            .map((action) => ({ type: action.action_type as HistoryEntry["actions"][number]["type"], title: payloadTitle(action.payload), state: action.state as ProposalState })),
        }),
      );
    },

    async addUserMessage(conversationId, content) {
      const supabase = await createClient();
      const { error } = await supabase.from("assistant_messages").insert({ conversation_id: conversationId, role: "user", content });
      return !error;
    },

    async addReply(conversationId, content, proposals) {
      const supabase = await createClient();
      const { error } = await supabase.rpc("add_assistant_reply", {
        p_conversation_id: conversationId,
        p_content: content,
        p_actions: proposals.map((proposal) => ({ action_type: proposal.type, payload: proposal.payload })),
      });
      return !error;
    },
  };
}

export function createConfirmDeps(userId: string): ConfirmDeps {
  return {
    async loadActions(ids) {
      const supabase = await createClient();
      const { data, error } = await supabase.from("assistant_actions").select("id, action_type, payload, state").eq("user_id", userId).in("id", ids);
      return error ? null : data;
    },
    async loadProjectIds() {
      const supabase = await createClient();
      const { data, error } = await supabase.from("projects").select("id").eq("user_id", userId);
      return error ? null : new Set(data.map((project) => project.id));
    },
    async execute(id) {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("execute_assistant_action", { p_action_id: id });
      const outcome = !error && Array.isArray(data) ? data[0]?.outcome : null;
      return outcome === "executed" || outcome === "already-executed" ? { ok: true, outcome } : { ok: false };
    },
  };
}

/** dismiss_assistant_action(id): the proposal's state afterwards, or null. */
export async function dismissProposal(id: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dismiss_assistant_action", { p_action_id: id });
  return error || typeof data !== "string" ? null : data;
}

/** Row limits for the context reads; context.ts trims further. */
const READ_LIMITS = { tasks: 200, completed: 30, events: 200, inbox: 15 };

/** The raw material of the model's context: the signed-in user's own rows, bounded. */
export async function loadContextSource(userId: string): Promise<ContextSource | null> {
  const supabase = await createClient();
  const today = currentISODate();
  const [projects, pending, completed, events, inbox] = await Promise.all([
    supabase.from("projects").select("id, name, status, area").eq("user_id", userId),
    supabase
      .from("tasks")
      .select("title, status, due_date, priority, project_id, source, completed_at")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("id")
      .limit(READ_LIMITS.tasks),
    supabase
      .from("tasks")
      .select("title, status, due_date, priority, project_id, source, completed_at")
      .eq("user_id", userId)
      .eq("status", "done")
      .gte("completed_at", `${addDays(today, -15)}T00:00:00Z`)
      .order("completed_at", { ascending: false })
      .limit(READ_LIMITS.completed),
    supabase
      .from("calendar_events")
      .select("title, event_date, start_time, end_time, all_day, location, project_id, source")
      .eq("user_id", userId)
      .gte("event_date", addDays(today, -1))
      .lte("event_date", addDays(today, 60))
      .order("event_date")
      .order("start_time", { nullsFirst: true })
      .limit(READ_LIMITS.events),
    supabase.from("inbox_items").select("kind, title, content, project_id, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(READ_LIMITS.inbox),
  ]);
  if (projects.error || pending.error || completed.error || events.error || inbox.error) return null;
  return { projects: projects.data, tasks: [...pending.data, ...completed.data], events: events.data, inbox: inbox.data };
}
