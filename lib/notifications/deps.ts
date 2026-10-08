import "server-only";
import type { DeliveryDeps } from "./delivery";
import { readPushConfig } from "./env";
import type { NotificationRunDeps } from "./run";
import { claimDelivery, createDeliveryStore, finishDelivery, loadPlannerData, loadPreferences } from "./store";
import { createWebPushSender } from "./web-push-sender";

// The real dependencies of notification delivery for the VERIFIED user `userId` (callers check the
// session first; RLS pins every row to that user as well). Shared by the test notification and the
// opportunistic planner run, so both deliver the same way.

/** Delivery to the user's own devices, or null when VAPID is not configured. */
export function createDeliveryDeps(userId: string): DeliveryDeps | null {
  const config = readPushConfig();
  if (!config.ok) return null;
  return { ...createDeliveryStore(userId), send: createWebPushSender(config.config) };
}

export function createNotificationRunDeps(userId: string): NotificationRunDeps {
  const delivery = createDeliveryDeps(userId);
  return {
    configured: delivery !== null,
    loadPreferences: () => loadPreferences(userId),
    loadPlannerData: (now) => loadPlannerData(userId, now),
    claim: claimDelivery,
    finish: finishDelivery,
    delivery: delivery ?? { loadSubscriptions: async () => [], removeSubscription: async () => false, send: async () => ({ ok: false, code: "push_rejected" }) },
    now: Date.now,
  };
}
