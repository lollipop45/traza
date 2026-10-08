import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DeliveryDeps, StoredSubscription } from "./delivery";
import type { PlannedNotification, PlannerEvent, PlannerTask } from "./planner";
import { plannerRange } from "./planner";
import { preferencesFromRow, type NotificationPreferences } from "./preferences";
import type { DeliveryStatus } from "./run";
import type { SubscriptionInput } from "./subscription";

// Supabase access for notifications, always as the SIGNED-IN user (RLS + functions pinned to
// auth.uid()). Server-only; callers must have verified the session. No user id is ever taken from
// the browser. Endpoints and keys are never logged; errors are not logged either.

export async function saveSubscription(input: SubscriptionInput): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth: input.auth,
    // Optional argument (SQL default null): omitted rather than sent as null.
    p_expiration_time: input.expirationTime ?? undefined,
  });
  return !error;
}

/** Removes THIS device's subscription only (the caller's own row with that endpoint). */
export async function deleteSubscriptionByEndpoint(userId: string, endpoint: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("push_subscriptions").delete().eq("user_id", userId).eq("endpoint", endpoint);
  return !error;
}

export async function countSubscriptions(userId: string): Promise<number | null> {
  const supabase = await createClient();
  const { count, error } = await supabase.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", userId);
  return error ? null : (count ?? 0);
}

export function createDeliveryStore(userId: string): Omit<DeliveryDeps, "send"> {
  return {
    async loadSubscriptions(): Promise<StoredSubscription[] | null> {
      const supabase = await createClient();
      const { data, error } = await supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId).order("created_at");
      return error ? null : data;
    },
    async removeSubscription(id: string): Promise<boolean> {
      const supabase = await createClient();
      const { error } = await supabase.from("push_subscriptions").delete().eq("id", id).eq("user_id", userId);
      return !error;
    },
  };
}

export async function loadPreferences(userId: string): Promise<NotificationPreferences | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("push_enabled, tomorrow_tasks, morning_summary, event_reminders, event_lead_minutes, show_details")
    .eq("user_id", userId)
    .maybeSingle();
  return error ? null : preferencesFromRow(data);
}

export async function savePreferences(preferences: NotificationPreferences): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_notification_preferences", {
    p_push_enabled: preferences.pushEnabled,
    p_tomorrow_tasks: preferences.tomorrowTasks,
    p_morning_summary: preferences.morningSummary,
    p_event_reminders: preferences.eventReminders,
    p_event_lead_minutes: preferences.eventLeadMinutes,
    p_show_details: preferences.showDetails,
  });
  return !error;
}

/** Pending tasks due up to tomorrow (overdue included, bounded) and today's/tomorrow's events. */
export async function loadPlannerData(userId: string, now: number): Promise<{ tasks: PlannerTask[]; events: PlannerEvent[] } | null> {
  const { today, tomorrow } = plannerRange(now);
  const supabase = await createClient();
  const [tasks, events] = await Promise.all([
    supabase.from("tasks").select("id, title, status, due_date").eq("user_id", userId).neq("status", "done").not("due_date", "is", null).lte("due_date", tomorrow).limit(500),
    supabase.from("calendar_events").select("id, title, event_date, start_time, all_day").eq("user_id", userId).gte("event_date", today).lte("event_date", tomorrow).limit(500),
  ]);
  if (tasks.error || events.error) return null;
  return { tasks: tasks.data, events: events.data };
}

export async function claimDelivery(planned: PlannedNotification): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("claim_notification_delivery", {
    p_kind: planned.kind,
    p_dedupe_key: planned.dedupeKey,
    p_scheduled_for: planned.scheduledFor,
    p_event_id: planned.eventId ?? undefined,
  });
  return error || typeof data !== "string" ? null : data;
}

export async function finishDelivery(id: string, status: DeliveryStatus, code: string | null): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("finish_notification_delivery", { p_id: id, p_status: status, p_failure_code: code ?? undefined });
  return !error && data === true;
}
