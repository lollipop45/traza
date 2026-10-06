import { createHash, randomBytes } from "node:crypto";
import { OAUTH_STATE_CONTEXT, decryptSecret, encryptSecret } from "./crypto";
import type { GoogleCalendarConfig, Keyring } from "./env";
import type { FetchLike, GoogleErrorKind } from "./types";

// Google OAuth 2.0, authorization-code flow for a confidential web client, with PKCE (S256) and an
// encrypted, short-lived state cookie. Runs only on the server: the client secret and the tokens
// never reach the browser. Errors are categories only (no bodies, no tokens).

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * The narrowest scopes for what TRAZA will need:
 *   calendar.calendarlist.readonly  list the user's calendars (to choose one; the primary
 *                                   calendar's id also identifies the account, so no identity
 *                                   scope such as `email` is requested);
 *   calendar.events.owned           read, create, change and delete events, but only on calendars
 *                                   the user OWNS (never calendars merely shared with them).
 * Not requested: `calendar` (full control, including deleting calendars and sharing settings),
 * `calendar.events` (events on every calendar the user can access) or any non-Calendar scope.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;

/** The state cookie expires quickly: an authorization must finish within this window. */
export const OAUTH_STATE_TTL_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 10_000;

const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export type PendingAuthorization = {
  state: string;
  codeVerifier: string;
  /** The TRAZA user who started it: the callback must be completed by the same user. */
  userId: string;
  issuedAt: number;
};

export function createPendingAuthorization(userId: string, now: number = Date.now()): PendingAuthorization {
  return { state: randomToken(), codeVerifier: randomToken(48), userId, issuedAt: now };
}

/** PKCE S256 challenge for a verifier (RFC 7636). */
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Encrypted + authenticated cookie value: unreadable and unforgeable without the server key. */
export function sealPendingAuthorization(pending: PendingAuthorization, keyring: Keyring): string {
  return encryptSecret(JSON.stringify(pending), keyring, OAUTH_STATE_CONTEXT);
}

export type PendingInspection =
  | { ok: true; pending: PendingAuthorization }
  /** missing: no cookie; decrypt: unreadable/tampered/foreign; expired: older than the TTL (or from the future). */
  | { ok: false; reason: "missing" | "decrypt" | "expired" };

/** Opens the state cookie, saying why it is unusable (for diagnostics; never its contents). */
export function inspectPendingAuthorization(sealed: string | undefined, keyring: Keyring, now: number = Date.now()): PendingInspection {
  if (!sealed) return { ok: false, reason: "missing" };
  const json = decryptSecret(sealed, keyring, OAUTH_STATE_CONTEXT);
  if (!json) return { ok: false, reason: "decrypt" };
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "decrypt" };
  }
  const { state, codeVerifier, userId, issuedAt } = value ?? {};
  if (typeof state !== "string" || typeof codeVerifier !== "string" || typeof userId !== "string" || typeof issuedAt !== "number") {
    return { ok: false, reason: "decrypt" };
  }
  const age = now - issuedAt;
  if (age < 0 || age > OAUTH_STATE_TTL_SECONDS * 1000) return { ok: false, reason: "expired" };
  return { ok: true, pending: { state, codeVerifier, userId, issuedAt } };
}

export function openPendingAuthorization(sealed: string | undefined, keyring: Keyring, now: number = Date.now()): PendingAuthorization | null {
  const inspected = inspectPendingAuthorization(sealed, keyring, now);
  return inspected.ok ? inspected.pending : null;
}

/**
 * Google's consent URL. access_type=offline + prompt=consent: Google issues a refresh token every
 * time (also on reconnection), so the user does not have to reconnect hourly.
 */
export function authorizationUrl(config: Pick<GoogleCalendarConfig, "clientId" | "redirectUri">, pending: PendingAuthorization): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", codeChallenge(pending.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type GoogleTokens = {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Present on code exchange (offline access); usually absent on refresh. */
  refreshToken: string | null;
  scopes: string[];
};

export type TokenResult = { ok: true; tokens: GoogleTokens } | { ok: false; kind: GoogleErrorKind };

/** Projects a token endpoint response; anything unexpected is "invalid-response". */
export function parseTokenResponse(value: unknown): GoogleTokens | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof accessToken !== "string" || !accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") return null;
  return {
    accessToken,
    expiresIn,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/** Every scope TRAZA asked for was granted (Google lets users untick individual permissions). */
export function hasRequiredScopes(granted: string[]): boolean {
  return GOOGLE_CALENDAR_SCOPES.every((scope) => granted.includes(scope));
}

async function postForm(fetchFn: FetchLike, url: string, form: Record<string, string>): Promise<Response | null> {
  try {
    return await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Network failure or timeout; the error itself is discarded (it may contain request details).
    return null;
  }
}

async function tokenRequest(fetchFn: FetchLike, form: Record<string, string>): Promise<TokenResult> {
  const response = await postForm(fetchFn, GOOGLE_TOKEN_URL, form);
  if (!response) return { ok: false, kind: "unavailable" };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : null;
    if (error === "invalid_grant") return { ok: false, kind: "revoked" };
    if (response.status === 429 || response.status >= 500) return { ok: false, kind: "unavailable" };
    return { ok: false, kind: error === "invalid_client" || error === "unauthorized_client" ? "unauthorized" : "invalid-response" };
  }
  const tokens = parseTokenResponse(body);
  return tokens ? { ok: true, tokens } : { ok: false, kind: "invalid-response" };
}

/** Exchanges the authorization code (server-side, with the client secret and PKCE verifier). */
export function exchangeAuthorizationCode(config: GoogleCalendarConfig, code: string, codeVerifier: string, fetchFn: FetchLike): Promise<TokenResult> {
  return tokenRequest(fetchFn, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
}

/** A new access token from the refresh token. invalid_grant ⇒ "revoked" (reconnect needed). */
export function refreshAccessToken(config: GoogleCalendarConfig, refreshToken: string, fetchFn: FetchLike): Promise<TokenResult> {
  return tokenRequest(fetchFn, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
}

/** Best-effort revocation (disconnect). True when Google confirmed it. */
export async function revokeToken(token: string, fetchFn: FetchLike): Promise<boolean> {
  const response = await postForm(fetchFn, GOOGLE_REVOKE_URL, { token });
  return Boolean(response?.ok);
}
