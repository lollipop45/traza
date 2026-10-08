import "server-only";
import webpush from "web-push";
import { pushFailureFromStatus, type PushSender, type SendResult } from "./delivery";
import type { PushConfig } from "./env";

// The real Web Push sender (VAPID + payload encryption, via the `web-push` library). Server-only:
// the private key never leaves this process. Errors are reduced to a safe category; the library's
// error (which can include the endpoint and the push service's response) is discarded, not logged.

/** How long a push service may hold an undelivered message (seconds). */
const TTL_SECONDS = 4 * 60 * 60;
const TIMEOUT_MS = 10_000;

export function createWebPushSender(config: PushConfig): PushSender {
  return async (subscription, payload): Promise<SendResult> => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: TTL_SECONDS,
          urgency: "normal",
          timeout: TIMEOUT_MS,
        },
      );
      return { ok: true };
    } catch (error) {
      const status = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
      return { ok: false, code: pushFailureFromStatus(status) };
    }
  };
}
