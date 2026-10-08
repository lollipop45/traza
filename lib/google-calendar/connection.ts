import { accountEmailFrom, isWritableCalendar, listCalendars } from "./client";
import { decryptSecret, encryptSecret, needsReencryption, safeEqual, tokenContext } from "./crypto";
import type { GoogleCalendarConfig } from "./env";
import {
  exchangeAuthorizationCode,
  hasRequiredScopes,
  inspectPendingAuthorization,
  refreshAccessToken,
  revokeToken,
} from "./oauth";
import type { FetchLike, GoogleCalendar, GoogleErrorKind } from "./types";

// The rules of the Google Calendar connection, independent of Next.js and Supabase so they can be
// tested with a mocked Google and store. lib/google-calendar/store.ts and actions.ts wire the real
// dependencies. Plain tokens exist only in memory here; they are encrypted before every write and
// never returned from these functions (except the access token handed to an API call).

export type StoredCredentials = { refreshCiphertext: string; accessCiphertext: string | null; accessExpiresAt: string | null };

export type ConnectionMetadata = {
  status: string;
  accountEmail: string | null;
  selectedCalendarId: string | null;
  selectedCalendarName: string | null;
};

/** Supabase access for the signed-in user's own row (RLS + get_google_calendar_credentials). */
export type ConnectionStore = {
  loadMetadata(): Promise<{ ok: true; metadata: ConnectionMetadata | null } | { ok: false }>;
  loadCredentials(): Promise<{ ok: true; credentials: StoredCredentials | null } | { ok: false }>;
  saveConnection(input: {
    accountEmail: string | null;
    refreshCiphertext: string;
    accessCiphertext: string;
    accessExpiresAt: string;
    keepSelection: boolean;
  }): Promise<boolean>;
  saveAccessToken(input: { accessCiphertext: string; accessExpiresAt: string; refreshCiphertext?: string }): Promise<boolean>;
  /** Wipes the tokens and marks the connection as needing reconnection. */
  markRevoked(): Promise<boolean>;
  saveSelectedCalendar(calendarId: string, calendarName: string): Promise<boolean>;
  deleteConnection(): Promise<boolean>;
};

export type ConnectionDeps = {
  config: GoogleCalendarConfig;
  /** The verified TRAZA user (encryption context). */
  userId: string;
  store: ConnectionStore;
  fetch: FetchLike;
  now: () => number;
  /**
   * Automatic sync only: an undecryptable refresh token (usually a changed or missing
   * GOOGLE_TOKEN_ENCRYPTION_KEY) is reported as "unreadable" and the stored connection is left
   * untouched, so restoring the right key recovers it. Manual actions keep the original behaviour
   * (mark the connection revoked so the user can reconnect).
   */
  keepUnreadableCredentials?: boolean;
};

/** Access tokens are refreshed this long before Google's expiry. */
const EXPIRY_MARGIN_MS = 60_000;

export type AccessFailure = "not-connected" | "revoked" | "unreadable" | "unavailable" | "unauthorized" | "storage";
export type AccessResult = { ok: true; accessToken: string } | { ok: false; kind: AccessFailure };

function fromGoogle(kind: GoogleErrorKind): AccessFailure {
  return kind === "revoked" ? "revoked" : kind === "unauthorized" ? "unauthorized" : "unavailable";
}

/**
 * A usable access token: the stored one while valid, otherwise a fresh one from the refresh
 * token. The refresh token is kept unless Google returns a replacement, and is re-encrypted if it
 * was stored under a previous key. A rejected refresh token (invalid_grant) or an undecryptable
 * one marks the connection as revoked: the user must reconnect.
 */
export async function getAccessToken(deps: ConnectionDeps, options: { forceRefresh?: boolean } = {}): Promise<AccessResult> {
  const loaded = await deps.store.loadCredentials();
  if (!loaded.ok) return { ok: false, kind: "storage" };
  const credentials = loaded.credentials;
  if (!credentials) return { ok: false, kind: "not-connected" };
  const { keyring } = deps.config;

  if (!options.forceRefresh && credentials.accessCiphertext && credentials.accessExpiresAt) {
    const stillValid = Date.parse(credentials.accessExpiresAt) - EXPIRY_MARGIN_MS > deps.now();
    const accessToken = stillValid ? decryptSecret(credentials.accessCiphertext, keyring, tokenContext(deps.userId, "access")) : null;
    if (accessToken) return { ok: true, accessToken };
  }

  const refreshToken = decryptSecret(credentials.refreshCiphertext, keyring, tokenContext(deps.userId, "refresh"));
  if (!refreshToken) {
    // Unreadable (e.g. the encryption key was replaced without keeping the previous one).
    if (deps.keepUnreadableCredentials) return { ok: false, kind: "unreadable" };
    await deps.store.markRevoked();
    return { ok: false, kind: "revoked" };
  }

  const refreshed = await refreshAccessToken(deps.config, refreshToken, deps.fetch);
  if (!refreshed.ok) {
    if (refreshed.kind === "revoked") await deps.store.markRevoked();
    return { ok: false, kind: fromGoogle(refreshed.kind) };
  }

  const { tokens } = refreshed;
  const replacement = tokens.refreshToken ?? (needsReencryption(credentials.refreshCiphertext, keyring) ? refreshToken : null);
  // A failed save only costs another refresh next time; the token is still valid now.
  await deps.store.saveAccessToken({
    accessCiphertext: encryptSecret(tokens.accessToken, keyring, tokenContext(deps.userId, "access")),
    accessExpiresAt: new Date(deps.now() + tokens.expiresIn * 1000).toISOString(),
    ...(replacement ? { refreshCiphertext: encryptSecret(replacement, keyring, tokenContext(deps.userId, "refresh")) } : {}),
  });
  return { ok: true, accessToken: tokens.accessToken };
}

/** What the UI may receive about a calendar: no access token, nothing secret. */
export type CalendarOption = { id: string; name: string; primary: boolean };

export type DiscoveryResult =
  | { ok: true; calendars: CalendarOption[]; selectedId: string | null; /** Listed but not writable (shared with the user). */ notOwned: number }
  | { ok: false; kind: AccessFailure };

/** The user's calendars (live), retrying once with a fresh token if Google rejects the stored one. */
export async function readCalendars(deps: ConnectionDeps): Promise<{ ok: true; calendars: GoogleCalendar[] } | { ok: false; kind: AccessFailure }> {
  const access = await getAccessToken(deps);
  if (!access.ok) return access;
  let listed = await listCalendars(access.accessToken, deps.fetch);
  if (!listed.ok && listed.kind === "unauthorized") {
    const retry = await getAccessToken(deps, { forceRefresh: true });
    if (!retry.ok) return retry;
    listed = await listCalendars(retry.accessToken, deps.fetch);
  }
  return listed.ok ? listed : { ok: false, kind: fromGoogle(listed.kind) };
}

/** Writable calendars the user can choose from, primary first. */
export async function discoverCalendars(deps: ConnectionDeps): Promise<DiscoveryResult> {
  const [listed, metadata] = await Promise.all([readCalendars(deps), deps.store.loadMetadata()]);
  if (!listed.ok) return listed;
  const writable = listed.calendars.filter(isWritableCalendar);
  return {
    ok: true,
    calendars: writable.map(({ id, name, primary }) => ({ id, name, primary })),
    selectedId: metadata.ok ? (metadata.metadata?.selectedCalendarId ?? null) : null,
    notOwned: listed.calendars.length - writable.length,
  };
}

export type SelectionResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Stores the chosen calendar. The browser sends only an id; it must be one of the user's writable
 * calendars in Google's live response, and the stored name comes from that response.
 */
export async function selectCalendar(deps: ConnectionDeps, calendarId: unknown): Promise<SelectionResult> {
  if (typeof calendarId !== "string" || calendarId.length === 0 || calendarId.length > 1024) return { ok: false, error: "El calendario no es válido." };
  const listed = await readCalendars(deps);
  if (!listed.ok) return { ok: false, error: accessFailureMessage(listed.kind) };
  const calendar = listed.calendars.find((candidate) => candidate.id === calendarId);
  if (!calendar || !isWritableCalendar(calendar)) return { ok: false, error: "TRAZA no puede escribir en ese calendario." };
  return (await deps.store.saveSelectedCalendar(calendar.id, calendar.name)) ? { ok: true, name: calendar.name } : { ok: false, error: "No se ha podido guardar." };
}

/**
 * Revokes the grant at Google (best effort: revoking the refresh token ends TRAZA's access) and
 * deletes the connection row (tokens and chosen calendar). Never touches TRAZA calendar events.
 */
export async function disconnect(deps: ConnectionDeps): Promise<{ ok: true; revokedAtGoogle: boolean } | { ok: false; error: string }> {
  const loaded = await deps.store.loadCredentials();
  let revokedAtGoogle = false;
  if (loaded.ok && loaded.credentials) {
    const refreshToken = decryptSecret(loaded.credentials.refreshCiphertext, deps.config.keyring, tokenContext(deps.userId, "refresh"));
    if (refreshToken) revokedAtGoogle = await revokeToken(refreshToken, deps.fetch);
  }
  return (await deps.store.deleteConnection()) ? { ok: true, revokedAtGoogle } : { ok: false, error: "No se ha podido desconectar." };
}

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

/** Result codes carried in the redirect back to /calendar (`?google=`). Never tokens. */
export const CALLBACK_CODES = ["conectado", "cancelado", "estado-invalido", "error-intercambio", "permisos-incompletos", "no-configurado", "error"] as const;
export type CallbackCode = (typeof CALLBACK_CODES)[number];

export type CallbackInput = {
  /** The sealed state cookie set when the flow started (deleted by the caller in every case). */
  sealedState: string | undefined;
  state: string | null;
  code: string | null;
  error: string | null;
  /** The TRAZA user verified for this request. */
  sessionUserId: string;
};

/**
 * Where a callback stopped, for DEVELOPMENT diagnostics only (`?google_error=`). A fixed vocabulary:
 * never a code, state, verifier, token, secret, key, Google response or database error.
 * `google_calendar_identity` is informational: identifying the account is optional, so a failure
 * there does not stop the connection (it is never the reason for an error redirect).
 */
export const CALLBACK_STAGES = [
  "session_missing",
  "state_cookie_missing",
  "state_cookie_decrypt",
  "state_expired",
  "state_mismatch",
  "user_mismatch",
  "oauth_denied",
  "oauth_error",
  "token_exchange",
  "refresh_token_missing",
  "scope_validation",
  "google_calendar_identity",
  "token_encryption",
  "database_store",
  "unexpected",
] as const;
export type CallbackStage = (typeof CALLBACK_STAGES)[number];

export function isCallbackStage(value: unknown): value is CallbackStage {
  return typeof value === "string" && (CALLBACK_STAGES as readonly string[]).includes(value);
}

export type CallbackOutcome = { code: CallbackCode; stage: CallbackStage | null };

const fail = (code: CallbackCode, stage: CallbackStage): CallbackOutcome => ({ code, stage });

/**
 * Completes the authorization:
 *   1. the state cookie must decrypt, be fresh (10 min) and match the `state` parameter (CSRF);
 *   2. the flow must have been started by this same TRAZA user;
 *   3. the code is exchanged on the server (client secret + PKCE verifier);
 *   4. a refresh token and every requested scope are required;
 *   5. the tokens are encrypted and stored; the account is identified from the calendar list.
 * The user-facing `code` is unchanged by diagnostics; `stage` says where a failure happened.
 */
export async function completeAuthorization(deps: Omit<ConnectionDeps, "userId">, input: CallbackInput): Promise<CallbackOutcome> {
  const inspected = inspectPendingAuthorization(input.sealedState, deps.config.keyring, deps.now());
  if (!inspected.ok) {
    return fail("estado-invalido", inspected.reason === "missing" ? "state_cookie_missing" : inspected.reason === "expired" ? "state_expired" : "state_cookie_decrypt");
  }
  const { pending } = inspected;
  if (!input.state || !safeEqual(input.state, pending.state)) return fail("estado-invalido", "state_mismatch");
  if (pending.userId !== input.sessionUserId) return fail("estado-invalido", "user_mismatch");
  if (input.error) return input.error === "access_denied" ? fail("cancelado", "oauth_denied") : fail("error", "oauth_error");
  if (!input.code) return fail("estado-invalido", "state_mismatch");

  const exchanged = await exchangeAuthorizationCode(deps.config, input.code, pending.codeVerifier, deps.fetch);
  if (!exchanged.ok) return fail("error-intercambio", "token_exchange");
  const { tokens } = exchanged;
  if (!tokens.refreshToken) {
    await revokeToken(tokens.accessToken, deps.fetch);
    return fail("error-intercambio", "refresh_token_missing");
  }
  if (!hasRequiredScopes(tokens.scopes)) {
    // Partial consent: TRAZA could not work with it, so the grant is not kept.
    await revokeToken(tokens.refreshToken, deps.fetch);
    return fail("permisos-incompletos", "scope_validation");
  }

  const userId = pending.userId;
  // Optional: identifies the account for display. A failure here does not stop the connection.
  const listed = await listCalendars(tokens.accessToken, deps.fetch);
  const accountEmail = listed.ok ? accountEmailFrom(listed.calendars) : null;
  const previous = await deps.store.loadMetadata();
  // Reconnecting the same Google account keeps the chosen calendar; another account clears it.
  const keepSelection = previous.ok && Boolean(previous.metadata?.accountEmail && accountEmail && previous.metadata.accountEmail === accountEmail);

  let ciphertexts: { refreshCiphertext: string; accessCiphertext: string };
  try {
    ciphertexts = {
      refreshCiphertext: encryptSecret(tokens.refreshToken, deps.config.keyring, tokenContext(userId, "refresh")),
      accessCiphertext: encryptSecret(tokens.accessToken, deps.config.keyring, tokenContext(userId, "access")),
    };
  } catch {
    // Discarded: the error could describe the inputs.
    return fail("error", "token_encryption");
  }

  const saved = await deps.store.saveConnection({
    accountEmail,
    ...ciphertexts,
    accessExpiresAt: new Date(deps.now() + tokens.expiresIn * 1000).toISOString(),
    keepSelection,
  });
  return saved ? { code: "conectado", stage: null } : fail("error", "database_store");
}

/**
 * The query string of the redirect back to /calendar. `google=<code>` always; `google_error=<stage>`
 * only when diagnostics are enabled (development), and only from the fixed stage list.
 */
export function callbackRedirectSearch(outcome: CallbackOutcome, diagnostics: boolean): URLSearchParams {
  const search = new URLSearchParams({ google: outcome.code });
  if (diagnostics && outcome.stage && isCallbackStage(outcome.stage)) search.set("google_error", outcome.stage);
  return search;
}

// ---------------------------------------------------------------------------
// Spanish copy
// ---------------------------------------------------------------------------

export function accessFailureMessage(kind: AccessFailure): string {
  switch (kind) {
    case "not-connected":
      return "Google Calendar no está conectado.";
    case "revoked":
      return "Google ha retirado el acceso de TRAZA. Vuelve a conectar Google Calendar.";
    case "unauthorized":
      return "Google ya no permite a TRAZA leer tus calendarios. Vuelve a conectar Google Calendar.";
    case "storage":
      return "No se ha podido leer la conexión con Google.";
    case "unreadable":
      return "No se pueden leer las credenciales guardadas de Google. Vuelve a conectar Google Calendar.";
    default:
      return "Google Calendar no está disponible en este momento.";
  }
}

export const CALLBACK_MESSAGES: Record<CallbackCode, string> = {
  conectado: "Google Calendar conectado. Elige el calendario que usará TRAZA.",
  cancelado: "Has cancelado la conexión con Google. No se ha guardado nada.",
  "estado-invalido": "La respuesta de Google no es válida o ha caducado. Inténtalo de nuevo.",
  "error-intercambio": "Google no ha completado la autorización. Inténtalo de nuevo.",
  "permisos-incompletos": "Faltan permisos: TRAZA necesita ver tus calendarios y gestionar eventos en los tuyos. No se ha guardado nada.",
  "no-configurado": "La integración con Google no está configurada.",
  error: "No se ha podido conectar Google Calendar.",
};

export function isCallbackCode(value: unknown): value is CallbackCode {
  return typeof value === "string" && (CALLBACK_CODES as readonly string[]).includes(value);
}
