import { deliverToUser, type DeliveryDeps } from "./delivery";
import { planNotifications, type PlannedNotification, type PlannerEvent, type PlannerTask } from "./planner";
import type { NotificationPreferences } from "./preferences";

// One planner run for ONE user: plan → claim each reminder by its dedupe key (durable, in the
// database) → deliver → record the outcome. Independent of Next.js and Supabase (tested with fakes).
// Today it runs inside the signed-in user's own request while TRAZA is open; Prompt 23's trusted
// scheduler will call it for each user with its own (server-side) deps. Repeating a run is harmless:
// a reminder already claimed, sent or skipped is never claimed again.

export type DeliveryStatus = "sent" | "skipped" | "failed";

export type NotificationRunDeps = {
  /** VAPID keys present on the server. Without them nothing is planned or claimed. */
  configured: boolean;
  loadPreferences: () => Promise<NotificationPreferences | null>;
  loadPlannerData: (now: number) => Promise<{ tasks: PlannerTask[]; events: PlannerEvent[] } | null>;
  /** claim_notification_delivery: the delivery id, or null when it must not be sent (again). */
  claim: (planned: PlannedNotification) => Promise<string | null>;
  /** finish_notification_delivery. */
  finish: (id: string, status: DeliveryStatus, code: string | null) => Promise<boolean>;
  delivery: DeliveryDeps;
  now: () => number;
};

export type NotificationRunResult = {
  outcome: "done" | "not_configured" | "disabled" | "unavailable";
  planned: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Already claimed / sent before (deduplicated). */
  duplicates: number;
};

const empty = (outcome: NotificationRunResult["outcome"]): NotificationRunResult => ({ outcome, planned: 0, sent: 0, skipped: 0, failed: 0, duplicates: 0 });

export async function runDueNotifications(deps: NotificationRunDeps): Promise<NotificationRunResult> {
  if (!deps.configured) return empty("not_configured");
  const preferences = await deps.loadPreferences();
  if (!preferences) return empty("unavailable");
  if (!preferences.pushEnabled) return empty("disabled");
  const now = deps.now();
  const data = await deps.loadPlannerData(now);
  if (!data) return empty("unavailable");

  const plan = planNotifications({ now, preferences, tasks: data.tasks, events: data.events });
  const result: NotificationRunResult = { ...empty("done"), planned: plan.length };
  for (const planned of plan) {
    const id = await deps.claim(planned).catch(() => null);
    if (!id) {
      result.duplicates++;
      continue;
    }
    const report = await deliverToUser(deps.delivery, planned.payload).catch(() => null);
    if (report && report.sent > 0) {
      result.sent++;
      await deps.finish(id, "sent", null).catch(() => false);
    } else if (report?.code === "no_subscriptions") {
      result.skipped++;
      await deps.finish(id, "skipped", "no_subscriptions").catch(() => false);
    } else {
      result.failed++;
      await deps.finish(id, "failed", report?.code ?? "unexpected").catch(() => false);
    }
  }
  return result;
}
