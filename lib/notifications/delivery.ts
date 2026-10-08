import { encodePayload, type PushPayload } from "./payload";

// Sending one payload to the CURRENT user's devices. Independent of Next.js, Supabase and the Web
// Push library (all injected), so it is tested with a fake push service. Only safe categories come
// out: never a provider message, status text, endpoint or key.
//
// Per subscription:
//   sent                   delivered to the push service;
//   expired_subscription   404/410: that device unsubscribed → its row is removed (only that one);
//   push_rejected          400/401/403/413: kept (usually a configuration problem, not the device);
//   temporary_error        429/5xx/network: kept, may be retried later.

export type StoredSubscription = { id: string; endpoint: string; p256dh: string; auth: string };

export type PushFailureCode = "expired_subscription" | "push_rejected" | "temporary_error";
export type SendResult = { ok: true } | { ok: false; code: PushFailureCode };

/** Sends an encrypted payload to one subscription (VAPID). Never throws. */
export type PushSender = (subscription: StoredSubscription, payload: string) => Promise<SendResult>;

export type DeliveryDeps = {
  /** The signed-in user's own subscriptions (RLS). Null on a database error. */
  loadSubscriptions: () => Promise<StoredSubscription[] | null>;
  /** Removes one of the user's own subscriptions. */
  removeSubscription: (id: string) => Promise<boolean>;
  send: PushSender;
};

export type DeliveryCode = "no_subscriptions" | PushFailureCode | "unexpected";

export type DeliveryReport = {
  devices: number;
  sent: number;
  expired: number;
  failed: number;
  /** Null when at least one device received it. */
  code: DeliveryCode | null;
};

/** HTTP status from the push service → safe category. */
export function pushFailureFromStatus(status: number | null): PushFailureCode {
  if (status === 404 || status === 410) return "expired_subscription";
  if (status === 400 || status === 401 || status === 403 || status === 413) return "push_rejected";
  return "temporary_error";
}

export async function deliverToUser(deps: DeliveryDeps, payload: PushPayload): Promise<DeliveryReport> {
  const json = encodePayload(payload);
  const subscriptions = await deps.loadSubscriptions();
  if (!subscriptions) return { devices: 0, sent: 0, expired: 0, failed: 0, code: "unexpected" };
  if (subscriptions.length === 0) return { devices: 0, sent: 0, expired: 0, failed: 0, code: "no_subscriptions" };
  if (!json) return { devices: subscriptions.length, sent: 0, expired: 0, failed: subscriptions.length, code: "push_rejected" };

  const report: DeliveryReport = { devices: subscriptions.length, sent: 0, expired: 0, failed: 0, code: null };
  /** The first failure other than an expired device (what to report if nothing was delivered). */
  let firstFailure: Exclude<PushFailureCode, "expired_subscription"> | null = null;
  for (const subscription of subscriptions) {
    let result: SendResult;
    try {
      result = await deps.send(subscription, json);
    } catch {
      result = { ok: false, code: "temporary_error" };
    }
    if (result.ok) {
      report.sent++;
      continue;
    }
    if (result.code === "expired_subscription") {
      report.expired++;
      await deps.removeSubscription(subscription.id).catch(() => false);
    } else {
      report.failed++;
      firstFailure ??= result.code;
    }
  }
  if (report.sent === 0) report.code = firstFailure ?? "expired_subscription";
  return report;
}
