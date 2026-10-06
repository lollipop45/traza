import { createHash } from "node:crypto";

// Google Calendar integration configuration. SERVER-ONLY values: none uses the NEXT_PUBLIC_ prefix,
// so Next.js never inlines them into browser bundles. The client secret and the encryption key are
// never logged, rendered, returned to the client or included in error messages.
//
//   GOOGLE_CLIENT_ID                     OAuth client of type "Web application" (Google Cloud)
//   GOOGLE_CLIENT_SECRET                 its secret
//   GOOGLE_REDIRECT_URI                  the exact callback URL registered in Google Cloud, per
//                                        environment (e.g. http://localhost:3000/api/integrations/google/callback)
//   GOOGLE_TOKEN_ENCRYPTION_KEY          32 random bytes, base64: encrypts tokens before storage
//   GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS optional, the key being rotated out (decrypt only)

export const GOOGLE_CALLBACK_PATH = "/api/integrations/google/callback";

export type EncryptionKey = { id: string; key: Buffer };
export type Keyring = { current: EncryptionKey; previous: EncryptionKey[] };

export type GoogleCalendarConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  keyring: Keyring;
};

export type GoogleConfigProblem = "missing" | "invalid-client" | "invalid-redirect-uri" | "invalid-encryption-key";
export type GoogleConfigResult = { ok: true; config: GoogleCalendarConfig } | { ok: false; problem: GoogleConfigProblem };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The callback URL must be explicit per environment (never derived from request headers): https,
 * or http only on loopback for local development; no credentials, query or fragment; and the path
 * of TRAZA's callback route. Google itself also requires an exact match with a registered URI.
 */
export function normalizeRedirectUri(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname.replace(/\/+$/, "") !== GOOGLE_CALLBACK_PATH) return null;
  return `${url.origin}${GOOGLE_CALLBACK_PATH}`;
}

/** Key id stored in each ciphertext: a short hash, so rotation knows which key decrypts what. */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 8);
}

/** 32 bytes of standard or url-safe base64 (e.g. `openssl rand -base64 32`). */
export function parseEncryptionKey(raw: string | undefined): EncryptionKey | null {
  const value = raw?.trim();
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length === 32 ? { id: keyIdOf(key), key } : null;
}

/** Reads and validates the configuration. `env` is injectable for tests; never logged. */
export function readGoogleCalendarConfig(env: Record<string, string | undefined> = process.env): GoogleConfigResult {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const rawRedirect = env.GOOGLE_REDIRECT_URI?.trim();
  const rawKey = env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!clientId || !clientSecret || !rawRedirect || !rawKey) return { ok: false, problem: "missing" };

  if (!/^[A-Za-z0-9.-]{10,200}\.apps\.googleusercontent\.com$/.test(clientId) || !/^[\x21-\x7e]{10,256}$/.test(clientSecret)) {
    return { ok: false, problem: "invalid-client" };
  }
  const redirectUri = normalizeRedirectUri(rawRedirect);
  if (!redirectUri) return { ok: false, problem: "invalid-redirect-uri" };

  const current = parseEncryptionKey(rawKey);
  const previousRaw = env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim();
  const previous = previousRaw ? parseEncryptionKey(previousRaw) : null;
  if (!current || (previousRaw && !previous)) return { ok: false, problem: "invalid-encryption-key" };

  return { ok: true, config: { clientId, clientSecret, redirectUri, keyring: { current, previous: previous ? [previous] : [] } } };
}
