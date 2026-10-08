// Web Push (VAPID) configuration. SERVER-ONLY values: none uses NEXT_PUBLIC_.
//
//   WEB_PUSH_VAPID_PUBLIC_KEY   P-256 public key, base64url (65 bytes). Not a secret: browsers need
//                               it to subscribe, and it reaches them through the Ajustes page props.
//   WEB_PUSH_VAPID_PRIVATE_KEY  its private key, base64url (32 bytes). SECRET: never logged,
//                               rendered or sent to the browser.
//   WEB_PUSH_SUBJECT            VAPID contact: "mailto:you@example.com" or an https URL. It is a
//                               contact for push services, never notification content.

export type PushConfig = { publicKey: string; privateKey: string; subject: string };
export type PushConfigProblem = "missing" | "invalid-public-key" | "invalid-private-key" | "invalid-subject";
export type PushConfigResult = { ok: true; config: PushConfig } | { ok: false; problem: PushConfigProblem };

/** 65-byte uncompressed point → 87 base64url chars (88 with padding). */
export function isVapidPublicKey(value: string): boolean {
  return /^B[A-Za-z0-9_-]{86}=?$/.test(value);
}

/** 32 bytes → 43 base64url chars (44 with padding). */
export function isVapidPrivateKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}=?$/.test(value);
}

export function isVapidSubject(value: string): boolean {
  return /^mailto:[^\s@]{1,64}@[^\s@]{1,190}$/.test(value) || /^https:\/\/[^\s]{3,200}$/.test(value);
}

/** Reads and validates the configuration. `env` is injectable for tests; never logged. */
export function readPushConfig(env: Record<string, string | undefined> = process.env): PushConfigResult {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return { ok: false, problem: "missing" };
  if (!isVapidPublicKey(publicKey)) return { ok: false, problem: "invalid-public-key" };
  if (!isVapidPrivateKey(privateKey)) return { ok: false, problem: "invalid-private-key" };
  if (!isVapidSubject(subject)) return { ok: false, problem: "invalid-subject" };
  return { ok: true, config: { publicKey, privateKey, subject } };
}

/** Only the public key, for the browser's subscribe() call; null when push is not configured. */
export function readPushPublicKey(env: Record<string, string | undefined> = process.env): string | null {
  const result = readPushConfig(env);
  return result.ok ? result.config.publicKey : null;
}
