"use client";

// Browser side of Web Push for THIS device. Permission is only ever requested from an explicit user
// gesture ("Activar notificaciones"), never on load. The subscription (endpoint + keys) goes only to
// TRAZA's own same-origin endpoint, with the session cookie; it is never logged or displayed.
import { PUSH_HEADER, PUSH_SUBSCRIPTION_PATH, PUSH_UNSUBSCRIBE_PATH } from "@/lib/notifications/request";
import { applicationServerKey } from "./device";

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (!existing) await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}

async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", [PUSH_HEADER]: "1" },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Whether this browser currently holds a push subscription (no permission prompt). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const existing = await navigator.serviceWorker.getRegistration("/");
    return existing ? await existing.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

/** Re-sends an existing subscription so the server's copy stays current (cheap, idempotent). */
export async function refreshSubscription(subscription: PushSubscription): Promise<boolean> {
  return post(PUSH_SUBSCRIPTION_PATH, { subscription: subscription.toJSON() });
}

export type EnableResult = "active" | "denied" | "dismissed" | "invalid-key" | "failed";

/**
 * MUST be called directly from a click handler: Notification.requestPermission() is the first call,
 * before any await (iOS requires it to be part of the user gesture).
 */
export async function enableNotifications(publicKey: string): Promise<EnableResult> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "dismissed";
  const key = applicationServerKey(publicKey);
  if (!key) return "invalid-key";
  try {
    const ready = await registration();
    const subscription = (await ready.pushManager.getSubscription()) ?? (await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    return (await refreshSubscription(subscription)) ? "active" : "failed";
  } catch {
    return "failed";
  }
}

/** "Desactivar en este dispositivo": unsubscribes this browser and removes only its server row. */
export async function disableNotifications(): Promise<boolean> {
  const subscription = await currentSubscription();
  if (!subscription) return true;
  const endpoint = subscription.endpoint;
  const removed = await post(PUSH_UNSUBSCRIBE_PATH, { endpoint });
  await subscription.unsubscribe().catch(() => false);
  return removed;
}
