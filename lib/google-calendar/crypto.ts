import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import type { Keyring } from "./env";

// Authenticated encryption (AES-256-GCM) for Google tokens and the OAuth state cookie. Runs only
// on the server (the key is server-only). Format: "v1.<keyId>.<iv>.<ciphertext+tag>", base64url.
//
// Every ciphertext is bound to a context (additional authenticated data), e.g.
// "traza:google-calendar:<userId>:refresh": a ciphertext copied to another user's row, or used as
// another kind of token, fails to decrypt. Tampering also fails (GCM tag). Rotation: set the new
// key as GOOGLE_TOKEN_ENCRYPTION_KEY and the old one as GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
// values are re-encrypted with the new key whenever they are next written (token refresh,
// reconnection). Once every stored value has been rewritten the previous key can be removed.

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(plaintext: string, keyring: Keyring, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyring.current.key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return [VERSION, keyring.current.id, iv.toString("base64url"), data.toString("base64url")].join(".");
}

/** The plaintext, or null for anything malformed, tampered, out of context or under an unknown key. */
export function decryptSecret(ciphertext: string, keyring: Keyring, context: string): string | null {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, keyId, ivText, dataText] = parts;
  const key = [keyring.current, ...keyring.previous].find((candidate) => candidate.id === keyId);
  if (!key) return null;
  try {
    const iv = Buffer.from(ivText, "base64url");
    const data = Buffer.from(dataText, "base64url");
    if (iv.length !== IV_BYTES || data.length <= TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key.key, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** True when the value was encrypted with an older key and should be rewritten. */
export function needsReencryption(ciphertext: string, keyring: Keyring): boolean {
  return ciphertext.split(".")[1] !== keyring.current.id;
}

/** Constant-time string comparison (OAuth state). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Encryption contexts: one per user and token kind. */
export const tokenContext = (userId: string, kind: "refresh" | "access") => `traza:google-calendar:${userId}:${kind}`;
export const OAUTH_STATE_CONTEXT = "traza:google-oauth-state";
