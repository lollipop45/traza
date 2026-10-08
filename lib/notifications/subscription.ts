// Validation of a browser PushSubscription sent to TRAZA (subscription JSON from
// PushSubscription.toJSON()). Pure; mirrors the database checks so bad input never reaches it.
// Endpoints and keys are sensitive: they are never logged or returned to the browser.

export type SubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** ISO instant, or null when the browser does not say. */
  expirationTime: string | null;
};

export const MAX_ENDPOINT_LENGTH = 2048;
/** A request body larger than this is rejected before parsing. */
export const MAX_SUBSCRIPTION_BODY_BYTES = 4096;

const BASE64URL = /^[A-Za-z0-9_-]+=*$/;

/** A push service URL: https, no credentials, sane length. */
export function parseEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 20 || value.length > MAX_ENDPOINT_LENGTH || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return value;
}

export function parseSubscription(value: unknown): SubscriptionInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const endpoint = parseEndpoint(raw.endpoint);
  const keys = raw.keys;
  if (!endpoint || typeof keys !== "object" || keys === null || Array.isArray(keys)) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || p256dh.length < 80 || p256dh.length > 100 || !BASE64URL.test(p256dh)) return null;
  if (typeof auth !== "string" || auth.length < 16 || auth.length > 44 || !BASE64URL.test(auth)) return null;

  let expirationTime: string | null = null;
  if (typeof raw.expirationTime === "number" && Number.isFinite(raw.expirationTime) && raw.expirationTime > 0) {
    const date = new Date(raw.expirationTime);
    if (!Number.isNaN(date.getTime())) expirationTime = date.toISOString();
  } else if (raw.expirationTime !== null && raw.expirationTime !== undefined) {
    return null;
  }
  return { endpoint, p256dh, auth, expirationTime };
}
