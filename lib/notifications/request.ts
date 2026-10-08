// Browser ↔ server contract of the notification endpoints (pure; shared by route handlers, the
// settings components and the service worker, which uses the same path and header literally).

export const PUSH_SUBSCRIPTION_PATH = "/api/notifications/subscription";
export const PUSH_UNSUBSCRIBE_PATH = "/api/notifications/unsubscribe";
export const NOTIFICATION_CHECK_PATH = "/api/notifications/check";

/** Custom header required by the same-origin check (lib/security/same-origin.ts). */
export const PUSH_HEADER = "x-traza-push";

/** Reads a small JSON body (length-bounded before parsing). Null when too large or not JSON. */
export async function readSmallJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).length > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
