// The Web Push payload TRAZA sends, and the rules that keep it small and safe. Pure. The service
// worker (public/sw.js) applies the same rules again on receipt, since push data is untrusted there.
//
// Only these fields ever travel: title, body, url, tag, kind. Never notes, descriptions, Canvas
// submission content, assistant conversations, OAuth data, e-mail addresses or ids beyond the tag.

/** TRAZA screens a notification may open (same-origin paths only; mirrored in public/sw.js). */
export const NOTIFICATION_PATHS = ["/", "/calendar", "/inbox", "/projects", "/assistant", "/settings"] as const;
export type NotificationPath = (typeof NOTIFICATION_PATHS)[number];

export type NotificationKind = "tomorrow_tasks" | "morning_summary" | "event_reminder" | "test";

export type PushPayload = {
  title: string;
  body: string;
  url: NotificationPath;
  tag: string;
  kind: NotificationKind;
};

export const MAX_TITLE = 80;
export const MAX_BODY = 240;
/** Far below the ~4 KB Web Push limit; a payload over it is never sent. */
export const MAX_PAYLOAD_BYTES = 1024;

/** A same-origin TRAZA path, or "/". Absolute, protocol-relative or unknown URLs are rejected. */
export function safeNotificationPath(value: unknown): NotificationPath {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return (NOTIFICATION_PATHS as readonly string[]).includes(value) ? (value as NotificationPath) : "/";
}

/** Whitespace collapsed, clipped with an ellipsis. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

export function buildPayload(input: { title?: string; body: string; url: string; tag: string; kind: NotificationKind }): PushPayload {
  return {
    title: clip(input.title ?? "TRAZA", MAX_TITLE) || "TRAZA",
    body: clip(input.body, MAX_BODY),
    url: safeNotificationPath(input.url),
    tag: /^[a-z0-9:_.-]{1,64}$/i.test(input.tag) ? input.tag : "traza",
    kind: input.kind,
  };
}

/** The JSON actually sent, or null if it would exceed MAX_PAYLOAD_BYTES. */
export function encodePayload(payload: PushPayload): string | null {
  const json = JSON.stringify(payload);
  return new TextEncoder().encode(json).length <= MAX_PAYLOAD_BYTES ? json : null;
}

export const TEST_PAYLOAD: PushPayload = buildPayload({ body: "Las notificaciones están funcionando.", url: "/settings", tag: "traza-test", kind: "test" });
