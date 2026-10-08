import "server-only";
import type { DeliveryDeps, StoredSubscription } from "@/lib/notifications/delivery";
import { readPushConfig } from "@/lib/notifications/env";
import { plannerRange, type PlannedNotification, type PlannerEvent, type PlannerTask } from "@/lib/notifications/planner";
import { preferencesFromRow, type NotificationPreferences } from "@/lib/notifications/preferences";
import type { DeliveryStatus, NotificationRunDeps } from "@/lib/notifications/run";
import { createWebPushSender } from "@/lib/notifications/web-push-sender";
import type { DeliverySnapshot } from "../policy";
import type { ScheduledScope } from "../scope";

// Scheduled counterpart of lib/notifications/{store,deps}.ts: the same reads and the same delivery
// bookkeeping for ONE target user, through a ScheduledScope (every statement pinned to that user;
// claim/finish through the scheduler_* variants of the same database functions). The planner, the
// payloads, the privacy rules and the delivery logic are the existing ones (runDueNotifications).

const PREFERENCE_COLUMNS = "push_enabled, tomorrow_tasks, morning_summary, event_reminders, event_lead_minutes, show_details";

type PreferenceRow = Parameters<typeof preferencesFromRow>[0];

export function createScheduledNotificationStore(scope: ScheduledScope) {
  return {
    async loadPreferences(): Promise<NotificationPreferences | null> {
      const { data, error } = await scope.select<NonNullable<PreferenceRow>>("notification_preferences", PREFERENCE_COLUMNS).maybeSingle();
      return error ? null : preferencesFromRow(data);
    },

    /** Pending tasks due up to tomorrow (overdue included, bounded) and today's/tomorrow's events. */
    async loadPlannerData(now: number): Promise<{ tasks: PlannerTask[]; events: PlannerEvent[] } | null> {
      const { today, tomorrow } = plannerRange(now);
      const [tasks, events] = await Promise.all([
        scope.select<PlannerTask>("tasks", "id, title, status, due_date").neq("status", "done").not("due_date", "is", null).lte("due_date", tomorrow).limit(500),
        scope.select<PlannerEvent>("calendar_events", "id, title, event_date, start_time, all_day").gte("event_date", today).lte("event_date", tomorrow).limit(500),
      ]);
      if (tasks.error || events.error) return null;
      return { tasks: tasks.data, events: events.data };
    },

    /** Existing delivery rows for these reminder keys (for the "is anything still open?" check). */
    async loadDeliveries(keys: string[]): Promise<DeliverySnapshot[] | null> {
      if (keys.length === 0) return [];
      const { data, error } = await scope.select<DeliverySnapshot>("notification_deliveries", "dedupe_key, status, failure_code, attempts, updated_at").in("dedupe_key", keys);
      return error ? null : data;
    },

    async claim(planned: PlannedNotification): Promise<string | null> {
      const { data, error } = await scope.rpc("scheduler_claim_notification_delivery", {
        p_kind: planned.kind,
        p_dedupe_key: planned.dedupeKey,
        p_scheduled_for: planned.scheduledFor,
        p_event_id: planned.eventId ?? undefined,
      });
      return error || typeof data !== "string" ? null : data;
    },

    async finish(id: string, status: DeliveryStatus, code: string | null): Promise<boolean> {
      const { data, error } = await scope.rpc("scheduler_finish_notification_delivery", { p_id: id, p_status: status, p_failure_code: code ?? undefined });
      return !error && data === true;
    },

    async loadSubscriptions(): Promise<StoredSubscription[] | null> {
      const { data, error } = await scope.select<StoredSubscription>("push_subscriptions", "id, endpoint, p256dh, auth").order("created_at");
      return error ? null : data;
    },

    /** Removes ONE expired device of this user. */
    async removeSubscription(id: string): Promise<boolean> {
      const { error } = await scope.delete("push_subscriptions").eq("id", id);
      return !error;
    },
  };
}

/** The existing runDueNotifications deps, for the scope's user. */
export function createScheduledNotificationDeps(scope: ScheduledScope): NotificationRunDeps {
  const store = createScheduledNotificationStore(scope);
  const config = readPushConfig();
  const delivery: DeliveryDeps = config.ok
    ? { loadSubscriptions: store.loadSubscriptions, removeSubscription: store.removeSubscription, send: createWebPushSender(config.config) }
    : { loadSubscriptions: async () => [], removeSubscription: async () => false, send: async () => ({ ok: false, code: "push_rejected" }) };
  return {
    configured: config.ok,
    loadPreferences: store.loadPreferences,
    loadPlannerData: store.loadPlannerData,
    claim: store.claim,
    finish: store.finish,
    delivery,
    now: Date.now,
  };
}
