import "server-only";
import { requireUser } from "@/lib/auth/session";
import { currentISODate, formatShortDate } from "@/lib/calendar/dates";
import { isAiConfigured } from "@/lib/ai/provider";
import { createClient } from "@/lib/supabase/server";
import { canaryDate, canaryTime } from "./clock";
import { actionView } from "./format";
import type { MessageRole, MessageView } from "./types";

// Server-side reads for the Assistant screen: the user's latest conversation, its messages and
// proposals (RLS: only their own). Nothing here calls the AI provider.

/** Messages shown; older ones stay stored. */
const MESSAGE_LIMIT = 60;

export type AssistantView = {
  conversationId: string | null;
  /** "6 OCT 2026" for the section header. */
  dateLabel: string | null;
  messages: MessageView[];
  /** Restrained starting points, from the user's own data. Never sent automatically. */
  suggestions: string[];
  configured: boolean;
};

export async function getAssistantView(): Promise<AssistantView | null> {
  const user = await requireUser();
  const supabase = await createClient();
  const today = currentISODate();

  const [conversation, projects, pending] = await Promise.all([
    supabase.from("assistant_conversations").select("id, updated_at").eq("user_id", user.id).order("updated_at", { ascending: false }).order("id").limit(1).maybeSingle(),
    supabase.from("projects").select("id, name, status").eq("user_id", user.id),
    supabase.from("tasks").select("project_id").eq("user_id", user.id).eq("status", "pending").not("project_id", "is", null).limit(500),
  ]);
  if (conversation.error || projects.error || pending.error) return null;
  const projectNames = new Map(projects.data.map((project) => [project.id, project.name]));

  // Suggestions: generic questions, plus the active project with most pending work.
  const counts = new Map<string, number>();
  for (const task of pending.data) if (task.project_id) counts.set(task.project_id, (counts.get(task.project_id) ?? 0) + 1);
  const busiest = projects.data
    .filter((project) => project.status === "active" && counts.has(project.id))
    .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name, "es"))[0];
  const suggestions = ["¿Qué tengo mañana?", "¿Cuál es mi próxima entrega?", ...(busiest ? [`¿Qué tengo pendiente en ${busiest.name}?`] : []), "Organiza mi semana"];

  const configured = isAiConfigured();
  if (!conversation.data) return { conversationId: null, dateLabel: null, messages: [], suggestions, configured };
  const conversationId = conversation.data.id;

  const messages = await supabase
    .from("assistant_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MESSAGE_LIMIT);
  if (messages.error) return null;
  const ids = messages.data.map((message) => message.id);
  const actions = ids.length
    ? await supabase.from("assistant_actions").select("id, message_id, action_type, payload, state, position").in("message_id", ids).order("position")
    : { data: [], error: null };
  if (actions.error) return null;

  const views: MessageView[] = [...messages.data].reverse().map((message) => ({
    id: message.id,
    role: message.role as MessageRole,
    content: message.content,
    createdAt: message.created_at,
    time: canaryTime(message.created_at),
    actions: actions.data
      .filter((action) => action.message_id === message.id)
      .map((action) => actionView(action, projectNames, today))
      .filter((view) => view !== null),
  }));
  return {
    conversationId,
    dateLabel: formatShortDate(canaryDate(conversation.data.updated_at)),
    messages: views,
    suggestions: views.length === 0 ? suggestions : [],
    configured,
  };
}
