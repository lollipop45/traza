// Google Calendar connection: configuration, encryption, OAuth state/PKCE, token exchange and
// refresh, calendar discovery/selection, disconnect and the callback rules. Google is mocked; no
// network and no real credentials (every secret below is a fake fixture).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { accountEmailFrom, isWritableCalendar, listCalendars, parseCalendar } from "@/lib/google-calendar/client";
import {
  CALLBACK_STAGES,
  callbackRedirectSearch,
  completeAuthorization,
  disconnect,
  discoverCalendars,
  getAccessToken,
  isCallbackStage,
  selectCalendar,
  type ConnectionDeps,
  type ConnectionMetadata,
  type ConnectionStore,
  type StoredCredentials,
} from "@/lib/google-calendar/connection";
import { OAUTH_COOKIE_NAME, oauthCookieOptions } from "@/lib/google-calendar/cookie";
import { decryptSecret, encryptSecret, needsReencryption, safeEqual, tokenContext } from "@/lib/google-calendar/crypto";
import { keyIdOf, normalizeRedirectUri, readGoogleCalendarConfig, type GoogleCalendarConfig, type Keyring } from "@/lib/google-calendar/env";
import {
  GOOGLE_CALENDAR_SCOPES,
  OAUTH_STATE_TTL_SECONDS,
  authorizationUrl,
  codeChallenge,
  createPendingAuthorization,
  exchangeAuthorizationCode,
  hasRequiredScopes,
  openPendingAuthorization,
  refreshAccessToken,
  sealPendingAuthorization,
} from "@/lib/google-calendar/oauth";
import type { FetchLike } from "@/lib/google-calendar/types";

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const NOW = Date.parse("2026-10-06T10:00:00Z");

const KEY = randomBytes(32);
const OLD_KEY = randomBytes(32);
const env = {
  GOOGLE_CLIENT_ID: "123456789012-fakeclientid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-FAKE-client-secret-not-real",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/integrations/google/callback",
  GOOGLE_TOKEN_ENCRYPTION_KEY: KEY.toString("base64"),
};
const configResult = readGoogleCalendarConfig(env);
assert.ok(configResult.ok);
const config: GoogleCalendarConfig = configResult.config;
const keyring: Keyring = config.keyring;

const REFRESH = "1//0gFAKE-refresh-token-not-real";
const ACCESS = "ya29.FAKE-access-token-not-real";
const NEW_ACCESS = "ya29.FAKE-new-access-token";
const NEW_REFRESH = "1//0gFAKE-rotated-refresh-token";
const SECRETS = [REFRESH, ACCESS, NEW_ACCESS, NEW_REFRESH, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_TOKEN_ENCRYPTION_KEY];
const GRANTED = GOOGLE_CALENDAR_SCOPES.join(" ");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("Google configuration", () => {
  it("requires every server-only variable and ignores NEXT_PUBLIC_ variants", () => {
    for (const missing of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_TOKEN_ENCRYPTION_KEY"] as const) {
      const partial = { ...env, [missing]: undefined };
      assert.deepEqual(readGoogleCalendarConfig(partial), { ok: false, problem: "missing" }, missing);
      assert.deepEqual(readGoogleCalendarConfig({ ...partial, [`NEXT_PUBLIC_${missing}`]: env[missing] }), { ok: false, problem: "missing" });
    }
  });

  it("validates the client, the redirect URI and the encryption key", () => {
    assert.deepEqual(readGoogleCalendarConfig({ ...env, GOOGLE_CLIENT_ID: "not-a-client" }), { ok: false, problem: "invalid-client" });
    assert.deepEqual(readGoogleCalendarConfig({ ...env, GOOGLE_CLIENT_SECRET: "x y" }), { ok: false, problem: "invalid-client" });
    assert.deepEqual(readGoogleCalendarConfig({ ...env, GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.from("short").toString("base64") }), { ok: false, problem: "invalid-encryption-key" });
    assert.deepEqual(readGoogleCalendarConfig({ ...env, GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS: "nope" }), { ok: false, problem: "invalid-encryption-key" });
    assert.deepEqual(readGoogleCalendarConfig({ ...env, GOOGLE_REDIRECT_URI: "http://traza.example.com/api/integrations/google/callback" }), {
      ok: false,
      problem: "invalid-redirect-uri",
    });
  });

  it("accepts only https (or loopback http) callbacks on TRAZA's callback path", () => {
    assert.equal(normalizeRedirectUri("https://traza.vercel.app/api/integrations/google/callback/"), "https://traza.vercel.app/api/integrations/google/callback");
    assert.equal(normalizeRedirectUri("http://127.0.0.1:3000/api/integrations/google/callback"), "http://127.0.0.1:3000/api/integrations/google/callback");
    for (const bad of [
      "https://traza.vercel.app/callback",
      "https://traza.vercel.app/api/integrations/google/callback?x=1",
      "https://user:pw@traza.vercel.app/api/integrations/google/callback",
      "javascript:alert(1)",
      "",
    ]) {
      assert.equal(normalizeRedirectUri(bad), null, bad);
    }
  });

  it("keeps a previous key for rotation", () => {
    const rotated = readGoogleCalendarConfig({ ...env, GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS: OLD_KEY.toString("base64url") });
    assert.ok(rotated.ok);
    assert.deepEqual(rotated.config.keyring.previous.map((k) => k.id), [keyIdOf(OLD_KEY)]);
  });
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

describe("token encryption", () => {
  const context = tokenContext(USER_A, "refresh");

  it("round-trips, with a fresh IV each time and the stored format", () => {
    const a = encryptSecret(REFRESH, keyring, context);
    const b = encryptSecret(REFRESH, keyring, context);
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a, keyring, context), REFRESH);
    assert.ok(!a.includes(REFRESH));
    // The same format the database check constraint accepts.
    assert.match(a, /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);
  });

  it("refuses tampering, another user's context, another token kind and unknown keys", () => {
    const sealed = encryptSecret(REFRESH, keyring, context);
    const parts = sealed.split(".");
    const flipped = parts[3][0] === "A" ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;
    assert.equal(decryptSecret([...parts.slice(0, 3), flipped].join("."), keyring, context), null);
    assert.equal(decryptSecret(sealed, keyring, tokenContext(USER_B, "refresh")), null);
    assert.equal(decryptSecret(sealed, keyring, tokenContext(USER_A, "access")), null);
    const other: Keyring = { current: { id: keyring.current.id, key: randomBytes(32) }, previous: [] };
    assert.equal(decryptSecret(sealed, other, context), null);
    for (const junk of ["", "v1", "v2.x.y.z", REFRESH, "v1.unknown.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA"]) assert.equal(decryptSecret(junk, keyring, context), null);
  });

  it("decrypts values from the previous key and flags them for re-encryption", () => {
    const oldRing: Keyring = { current: { id: keyIdOf(OLD_KEY), key: OLD_KEY }, previous: [] };
    const rotated: Keyring = { current: keyring.current, previous: [oldRing.current] };
    const legacy = encryptSecret(REFRESH, oldRing, context);
    assert.equal(decryptSecret(legacy, rotated, context), REFRESH);
    assert.equal(needsReencryption(legacy, rotated), true);
    assert.equal(needsReencryption(encryptSecret(REFRESH, rotated, context), rotated), false);
  });

  it("compares states in constant time", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "abcd"), false);
  });
});

// ---------------------------------------------------------------------------
// OAuth: state, PKCE, URL
// ---------------------------------------------------------------------------

describe("OAuth state and PKCE", () => {
  it("seals the pending authorization in an encrypted, expiring cookie", () => {
    const pending = createPendingAuthorization(USER_A, NOW);
    const sealed = sealPendingAuthorization(pending, keyring);
    assert.ok(!sealed.includes(pending.state) && !sealed.includes(pending.codeVerifier));
    assert.deepEqual(openPendingAuthorization(sealed, keyring, NOW + 1000), pending);
    assert.equal(openPendingAuthorization(sealed, keyring, NOW + (OAUTH_STATE_TTL_SECONDS + 1) * 1000), null);
    assert.equal(openPendingAuthorization(sealed, keyring, NOW - 5000), null);
    assert.equal(openPendingAuthorization(undefined, keyring, NOW), null);
    const [v, id, iv, data] = sealed.split(".");
    const flipped = data.slice(0, 5) + (data[5] === "A" ? "B" : "A") + data.slice(6);
    assert.equal(openPendingAuthorization([v, id, iv, flipped].join("."), keyring, NOW), null);
    // A state encrypted as a token (other context) is not a valid cookie.
    assert.equal(openPendingAuthorization(encryptSecret(JSON.stringify(pending), keyring, tokenContext(USER_A, "access")), keyring, NOW), null);
  });

  it("uses random, unique state and verifier values", () => {
    const a = createPendingAuthorization(USER_A, NOW);
    const b = createPendingAuthorization(USER_A, NOW);
    assert.notEqual(a.state, b.state);
    assert.notEqual(a.codeVerifier, b.codeVerifier);
    assert.ok(a.state.length >= 43 && a.codeVerifier.length >= 43 && a.codeVerifier.length <= 128);
  });

  it("builds Google's consent URL with S256 PKCE, offline access and only the calendar scopes", () => {
    const pending = createPendingAuthorization(USER_A, NOW);
    const url = new URL(authorizationUrl(config, pending));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    assert.deepEqual(
      [p.get("client_id"), p.get("redirect_uri"), p.get("response_type"), p.get("access_type"), p.get("prompt"), p.get("state"), p.get("code_challenge_method")],
      [env.GOOGLE_CLIENT_ID, env.GOOGLE_REDIRECT_URI, "code", "offline", "consent", pending.state, "S256"],
    );
    assert.equal(p.get("code_challenge"), createHash("sha256").update(pending.codeVerifier).digest("base64url"));
    assert.equal(p.get("code_challenge"), codeChallenge(pending.codeVerifier));
    assert.deepEqual(p.get("scope")?.split(" "), [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ]);
    const text = url.toString();
    assert.ok(!text.includes(env.GOOGLE_CLIENT_SECRET) && !text.includes(pending.codeVerifier));
  });

  it("sets an httpOnly, path-scoped, short-lived cookie (Secure on https)", () => {
    assert.equal(OAUTH_COOKIE_NAME, "traza_google_oauth");
    assert.deepEqual(oauthCookieOptions(env.GOOGLE_REDIRECT_URI), {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/api/integrations/google/callback",
      maxAge: 600,
    });
    assert.equal(oauthCookieOptions("https://traza.vercel.app/api/integrations/google/callback").secure, true);
  });

  it("requires every requested scope", () => {
    assert.equal(hasRequiredScopes([...GOOGLE_CALENDAR_SCOPES]), true);
    assert.equal(hasRequiredScopes([GOOGLE_CALENDAR_SCOPES[0]]), false);
    assert.equal(hasRequiredScopes([]), false);
  });
});

// ---------------------------------------------------------------------------
// Mock Google
// ---------------------------------------------------------------------------

type Call = { url: string; init: RequestInit; body: URLSearchParams };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const CALENDARS = [
  { id: "ana@example.com", summary: "ana@example.com", primary: true, accessRole: "owner" },
  { id: "traza123@group.calendar.google.com", summary: "TRAZA", accessRole: "owner" },
  { id: "clase@group.calendar.google.com", summary: "Horario ETSA", accessRole: "reader" },
  { id: "equipo@group.calendar.google.com", summary: "Equipo", summaryOverride: "Equipo maqueta", accessRole: "writer" },
];

function google(options: {
  token?: (form: URLSearchParams) => Response;
  calendars?: (auth: string | null, pageToken: string | null) => Response;
  revoke?: () => Response;
  fail?: boolean;
} = {}) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    calls.push({ url, init, body });
    if (options.fail) throw new Error(`network down ${url}`);
    const parsed = new URL(url);
    if (parsed.href.startsWith("https://oauth2.googleapis.com/token")) {
      return options.token ? options.token(body) : json({ access_token: NEW_ACCESS, expires_in: 3599, token_type: "Bearer", scope: GRANTED });
    }
    if (parsed.href.startsWith("https://oauth2.googleapis.com/revoke")) return options.revoke ? options.revoke() : new Response("", { status: 200 });
    if (parsed.pathname === "/calendar/v3/users/me/calendarList") {
      const auth = new Headers(init.headers).get("Authorization");
      return options.calendars ? options.calendars(auth, parsed.searchParams.get("pageToken")) : json({ items: CALENDARS });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchFn, calls };
}

// ---------------------------------------------------------------------------
// Token exchange and refresh
// ---------------------------------------------------------------------------

describe("token endpoint", () => {
  it("exchanges the code server-side with the secret and PKCE verifier in the body", async () => {
    const g = google({ token: () => json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, token_type: "Bearer", scope: GRANTED }) });
    const result = await exchangeAuthorizationCode(config, "4/FAKE-code", "verifier-value", g.fetch);
    assert.deepEqual(result, { ok: true, tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3599, scopes: [...GOOGLE_CALENDAR_SCOPES] } });
    const [call] = g.calls;
    assert.equal(call.url, "https://oauth2.googleapis.com/token");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "manual");
    assert.deepEqual(Object.fromEntries(call.body), {
      grant_type: "authorization_code",
      code: "4/FAKE-code",
      code_verifier: "verifier-value",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
    });
    assert.ok(!call.url.includes(env.GOOGLE_CLIENT_SECRET));
  });

  it("categorises failures without echoing Google's response", async () => {
    const cases: [Partial<Parameters<typeof google>[0]>, string][] = [
      [{ token: () => json({ error: "invalid_grant", error_description: `Bad ${REFRESH}` }, 400) }, "revoked"],
      [{ token: () => json({ error: "invalid_client" }, 401) }, "unauthorized"],
      [{ token: () => json({ error: "server_error" }, 503) }, "unavailable"],
      [{ token: () => json({ error: "rate" }, 429) }, "unavailable"],
      [{ token: () => new Response("<html>oops</html>", { status: 200 }) }, "invalid-response"],
      [{ token: () => json({ access_token: ACCESS }) }, "invalid-response"],
      [{ token: () => json({ access_token: ACCESS, expires_in: 3600, token_type: "mac" }) }, "invalid-response"],
      [{ fail: true }, "unavailable"],
    ];
    for (const [options, kind] of cases) {
      const result = await exchangeAuthorizationCode(config, "code", "verifier", google(options).fetch);
      assert.deepEqual(result, { ok: false, kind });
      assert.ok(!JSON.stringify(result).includes(REFRESH));
    }
  });

  it("refreshes with the refresh token, and reports invalid_grant as revoked", async () => {
    const g = google();
    const ok = await refreshAccessToken(config, REFRESH, g.fetch);
    assert.ok(ok.ok && ok.tokens.accessToken === NEW_ACCESS && ok.tokens.refreshToken === null);
    assert.deepEqual(Object.fromEntries(g.calls[0].body), {
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    });
    assert.deepEqual(await refreshAccessToken(config, REFRESH, google({ token: () => json({ error: "invalid_grant" }, 400) }).fetch), { ok: false, kind: "revoked" });
  });
});

// ---------------------------------------------------------------------------
// Calendar list
// ---------------------------------------------------------------------------

describe("calendar list", () => {
  it("projects only id, name, primary and role, preferring the user's own name", () => {
    assert.deepEqual(parseCalendar({ ...CALENDARS[3], etag: "x", colorId: "3", defaultReminders: [] }), {
      id: "equipo@group.calendar.google.com",
      name: "Equipo maqueta",
      primary: false,
      accessRole: "writer",
    });
    for (const bad of [null, "x", [], {}, { id: "" }, { id: "a", deleted: true }]) assert.equal(parseCalendar(bad), null);
  });

  it("follows pages, sorts primary first and sends the token only as a Bearer header", async () => {
    const g = google({
      calendars: (auth, pageToken) =>
        pageToken ? json({ items: [CALENDARS[2], CALENDARS[3]] }) : auth === `Bearer ${ACCESS}` ? json({ items: [CALENDARS[1], CALENDARS[0]], nextPageToken: "p2" }) : json({}, 401),
    });
    const result = await listCalendars(ACCESS, g.fetch);
    assert.ok(result.ok);
    assert.deepEqual(result.calendars.map((c) => c.name), ["ana@example.com", "Equipo maqueta", "Horario ETSA", "TRAZA"]);
    assert.equal(g.calls.length, 2);
    assert.ok(g.calls.every((call) => !call.url.includes(ACCESS)));
    assert.equal(accountEmailFrom(result.calendars), "ana@example.com");
  });

  it("offers only calendars the user owns", () => {
    assert.deepEqual(CALENDARS.map((c) => isWritableCalendar(c)), [true, true, false, false]);
  });

  it("maps HTTP failures to categories", async () => {
    assert.deepEqual(await listCalendars(ACCESS, google({ calendars: () => json({}, 401) }).fetch), { ok: false, kind: "unauthorized" });
    assert.deepEqual(await listCalendars(ACCESS, google({ calendars: () => json({}, 503) }).fetch), { ok: false, kind: "unavailable" });
    assert.deepEqual(await listCalendars(ACCESS, google({ calendars: () => json({ items: "x" }) }).fetch), { ok: false, kind: "invalid-response" });
    assert.deepEqual(await listCalendars(ACCESS, google({ fail: true }).fetch), { ok: false, kind: "unavailable" });
  });
});

// ---------------------------------------------------------------------------
// Connection rules (fake store)
// ---------------------------------------------------------------------------

function memoryStore(initial: { credentials?: StoredCredentials | null; metadata?: ConnectionMetadata | null } = {}) {
  const state = {
    credentials: initial.credentials ?? null,
    metadata: initial.metadata ?? null,
    revoked: false,
    deleted: false,
    writes: [] as string[],
  };
  const store: ConnectionStore = {
    async loadMetadata() {
      return { ok: true, metadata: state.metadata };
    },
    async loadCredentials() {
      return { ok: true, credentials: state.credentials };
    },
    async saveConnection(input) {
      state.writes.push(JSON.stringify(input));
      state.credentials = { refreshCiphertext: input.refreshCiphertext, accessCiphertext: input.accessCiphertext, accessExpiresAt: input.accessExpiresAt };
      state.metadata = {
        status: "connected",
        accountEmail: input.accountEmail,
        selectedCalendarId: input.keepSelection ? (state.metadata?.selectedCalendarId ?? null) : null,
        selectedCalendarName: input.keepSelection ? (state.metadata?.selectedCalendarName ?? null) : null,
      };
      return true;
    },
    async saveAccessToken(input) {
      state.writes.push(JSON.stringify(input));
      if (!state.credentials) return false;
      state.credentials = { ...state.credentials, accessCiphertext: input.accessCiphertext, accessExpiresAt: input.accessExpiresAt, ...(input.refreshCiphertext ? { refreshCiphertext: input.refreshCiphertext } : {}) };
      return true;
    },
    async markRevoked() {
      state.revoked = true;
      state.credentials = null;
      if (state.metadata) state.metadata = { ...state.metadata, status: "revoked" };
      return true;
    },
    async saveSelectedCalendar(id, name) {
      state.writes.push(JSON.stringify({ id, name }));
      if (!state.metadata) return false;
      state.metadata = { ...state.metadata, selectedCalendarId: id, selectedCalendarName: name };
      return true;
    },
    async deleteConnection() {
      state.deleted = true;
      state.credentials = null;
      state.metadata = null;
      return true;
    },
  };
  return { store, state };
}

function stored(user = USER_A, options: { accessValidFor?: number; ring?: Keyring; refresh?: string } = {}): StoredCredentials {
  const ring = options.ring ?? keyring;
  const validFor = options.accessValidFor ?? 30 * 60_000;
  return {
    refreshCiphertext: encryptSecret(options.refresh ?? REFRESH, ring, tokenContext(user, "refresh")),
    accessCiphertext: encryptSecret(ACCESS, ring, tokenContext(user, "access")),
    accessExpiresAt: new Date(NOW + validFor).toISOString(),
  };
}

const connectedMeta: ConnectionMetadata = { status: "connected", accountEmail: "ana@example.com", selectedCalendarId: null, selectedCalendarName: null };

function deps(store: ConnectionStore, fetchFn: FetchLike, overrides: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return { config, userId: USER_A, store, fetch: fetchFn, now: () => NOW, ...overrides };
}

const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 12)}…`);
};

describe("access tokens", () => {
  it("uses a still-valid stored access token without calling Google", async () => {
    const g = google();
    const { store } = memoryStore({ credentials: stored() });
    assert.deepEqual(await getAccessToken(deps(store, g.fetch)), { ok: true, accessToken: ACCESS });
    assert.equal(g.calls.length, 0);
  });

  it("refreshes an expired one, stores it encrypted and keeps the refresh token", async () => {
    const g = google();
    const { store, state } = memoryStore({ credentials: stored(USER_A, { accessValidFor: 30_000 }) });
    const before = state.credentials!.refreshCiphertext;
    assert.deepEqual(await getAccessToken(deps(store, g.fetch)), { ok: true, accessToken: NEW_ACCESS });
    assert.equal(state.credentials!.refreshCiphertext, before);
    assert.equal(decryptSecret(state.credentials!.accessCiphertext!, keyring, tokenContext(USER_A, "access")), NEW_ACCESS);
    assert.equal(state.credentials!.accessExpiresAt, new Date(NOW + 3599_000).toISOString());
    for (const write of state.writes) for (const secret of SECRETS) assert.ok(!write.includes(secret));
  });

  it("stores a replacement refresh token when Google rotates it", async () => {
    const g = google({ token: () => json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3599, token_type: "Bearer" }) });
    const { store, state } = memoryStore({ credentials: stored(USER_A, { accessValidFor: 0 }) });
    await getAccessToken(deps(store, g.fetch));
    assert.equal(decryptSecret(state.credentials!.refreshCiphertext, keyring, tokenContext(USER_A, "refresh")), NEW_REFRESH);
  });

  it("re-encrypts a refresh token stored under the previous key", async () => {
    const oldRing: Keyring = { current: { id: keyIdOf(OLD_KEY), key: OLD_KEY }, previous: [] };
    const rotatedConfig = { ...config, keyring: { current: keyring.current, previous: [oldRing.current] } };
    const { store, state } = memoryStore({ credentials: stored(USER_A, { accessValidFor: 0, ring: oldRing }) });
    await getAccessToken(deps(store, google().fetch, { config: rotatedConfig }));
    assert.equal(needsReencryption(state.credentials!.refreshCiphertext, rotatedConfig.keyring), false);
    assert.equal(decryptSecret(state.credentials!.refreshCiphertext, keyring, tokenContext(USER_A, "refresh")), REFRESH);
  });

  it("marks the connection revoked when Google rejects the refresh token", async () => {
    const { store, state } = memoryStore({ credentials: stored(USER_A, { accessValidFor: 0 }), metadata: connectedMeta });
    const result = await getAccessToken(deps(store, google({ token: () => json({ error: "invalid_grant" }, 400) }).fetch));
    assert.deepEqual(result, { ok: false, kind: "revoked" });
    assert.equal(state.revoked, true);
    assert.equal(state.credentials, null);
  });

  it("marks it revoked when the stored refresh token cannot be decrypted (key lost)", async () => {
    const lost: Keyring = { current: { id: "lostkey1", key: randomBytes(32) }, previous: [] };
    const { store, state } = memoryStore({ credentials: stored(USER_A, { accessValidFor: 0, ring: lost }) });
    assert.deepEqual(await getAccessToken(deps(store, google().fetch)), { ok: false, kind: "revoked" });
    assert.equal(state.revoked, true);
  });

  it("does not revoke on a temporary Google outage", async () => {
    const { store, state } = memoryStore({ credentials: stored(USER_A, { accessValidFor: 0 }) });
    assert.deepEqual(await getAccessToken(deps(store, google({ token: () => json({}, 503) }).fetch)), { ok: false, kind: "unavailable" });
    assert.equal(state.revoked, false);
  });

  it("cannot use another user's ciphertext (bound to the user)", async () => {
    const { store, state } = memoryStore({ credentials: stored(USER_B, { accessValidFor: 30 * 60_000 }) });
    const g = google();
    assert.deepEqual(await getAccessToken(deps(store, g.fetch)), { ok: false, kind: "revoked" });
    assert.equal(g.calls.length, 0, "B's refresh token never reaches Google on A's behalf");
    assert.equal(state.revoked, true);
  });

  it("reports a missing connection", async () => {
    assert.deepEqual(await getAccessToken(deps(memoryStore().store, google().fetch)), { ok: false, kind: "not-connected" });
  });
});

describe("calendar discovery and selection", () => {
  it("offers only owned calendars, primary first, with no token in the result", async () => {
    const { store } = memoryStore({ credentials: stored(), metadata: connectedMeta });
    const result = await discoverCalendars(deps(store, google().fetch));
    assert.deepEqual(result, {
      ok: true,
      calendars: [
        { id: "ana@example.com", name: "ana@example.com", primary: true },
        { id: "traza123@group.calendar.google.com", name: "TRAZA", primary: false },
      ],
      selectedId: null,
      notOwned: 2,
    });
    noSecrets(result);
  });

  it("retries once with a fresh token when Google rejects the stored one", async () => {
    const g = google({ calendars: (auth) => (auth === `Bearer ${NEW_ACCESS}` ? json({ items: CALENDARS }) : json({}, 401)) });
    const { store } = memoryStore({ credentials: stored(), metadata: connectedMeta });
    const result = await discoverCalendars(deps(store, g.fetch));
    assert.ok(result.ok);
    assert.equal(g.calls.filter((call) => call.url.startsWith("https://oauth2.googleapis.com/token")).length, 1);
  });

  it("stores the chosen calendar with Google's name, never the browser's", async () => {
    const { store, state } = memoryStore({ credentials: stored(), metadata: connectedMeta });
    assert.deepEqual(await selectCalendar(deps(store, google().fetch), "traza123@group.calendar.google.com"), { ok: true, name: "TRAZA" });
    assert.deepEqual([state.metadata?.selectedCalendarId, state.metadata?.selectedCalendarName], ["traza123@group.calendar.google.com", "TRAZA"]);
  });

  it("refuses calendars the user does not own, unknown ids and bad input", async () => {
    for (const id of ["equipo@group.calendar.google.com", "clase@group.calendar.google.com", "otro@example.com", "", 42, null, "x".repeat(1025)]) {
      const { store, state } = memoryStore({ credentials: stored(), metadata: connectedMeta });
      const result = await selectCalendar(deps(store, google().fetch), id);
      assert.equal(result.ok, false, String(id));
      assert.equal(state.metadata?.selectedCalendarId, null);
    }
  });

  it("explains a revoked authorization in Spanish", async () => {
    const { store } = memoryStore({ credentials: stored(USER_A, { accessValidFor: 0 }), metadata: connectedMeta });
    const result = await selectCalendar(deps(store, google({ token: () => json({ error: "invalid_grant" }, 400) }).fetch), "ana@example.com");
    assert.deepEqual(result, { ok: false, error: "Google ha retirado el acceso de TRAZA. Vuelve a conectar Google Calendar." });
  });
});

describe("disconnect", () => {
  it("revokes the refresh token at Google and deletes the connection", async () => {
    const g = google();
    const { store, state } = memoryStore({ credentials: stored(), metadata: { ...connectedMeta, selectedCalendarId: "ana@example.com", selectedCalendarName: "ana" } });
    const result = await disconnect(deps(store, g.fetch));
    assert.deepEqual(result, { ok: true, revokedAtGoogle: true });
    assert.equal(state.deleted, true);
    const revoke = g.calls.find((call) => call.url === "https://oauth2.googleapis.com/revoke");
    assert.equal(revoke?.body.get("token"), REFRESH);
    assert.ok(!revoke?.url.includes(REFRESH), "the token travels in the POST body, not the URL");
    noSecrets(result);
  });

  it("still deletes the connection if Google cannot be reached or the token is unreadable", async () => {
    const offline = memoryStore({ credentials: stored() });
    assert.deepEqual(await disconnect(deps(offline.store, google({ fail: true }).fetch)), { ok: true, revokedAtGoogle: false });
    assert.equal(offline.state.deleted, true);
    const revoked = memoryStore({ credentials: null, metadata: { ...connectedMeta, status: "revoked" } });
    const g = google();
    assert.deepEqual(await disconnect(deps(revoked.store, g.fetch)), { ok: true, revokedAtGoogle: false });
    assert.equal(g.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

describe("OAuth callback", () => {
  const exchangeOk = () => json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, token_type: "Bearer", scope: GRANTED });

  function started(user = USER_A, at = NOW) {
    const pending = createPendingAuthorization(user, at);
    return { pending, sealed: sealPendingAuthorization(pending, keyring) };
  }

  const callbackDeps = (store: ConnectionStore, fetchFn: FetchLike) => ({ config, store, fetch: fetchFn, now: () => NOW });

  /** Flips a character in the middle of the ciphertext (the last one may only hold padding bits). */
  function tamper(sealed: string): string {
    const parts = sealed.split(".");
    const data = parts[3];
    const i = Math.floor(data.length / 2);
    parts[3] = data.slice(0, i) + (data[i] === "A" ? "B" : "A") + data.slice(i + 1);
    return parts.join(".");
  }

  it("connects: exchanges the code, stores only ciphertext, identifies the account", async () => {
    const g = google({ token: exchangeOk });
    const { store, state } = memoryStore();
    const { pending, sealed } = started();
    const outcome = await completeAuthorization(callbackDeps(store, g.fetch), { sealedState: sealed, state: pending.state, code: "4/FAKE", error: null, sessionUserId: USER_A });
    assert.deepEqual(outcome, { code: "conectado", stage: null });
    assert.equal(g.calls[0].body.get("code_verifier"), pending.codeVerifier);
    assert.equal(decryptSecret(state.credentials!.refreshCiphertext, keyring, tokenContext(USER_A, "refresh")), REFRESH);
    assert.equal(state.metadata?.accountEmail, "ana@example.com");
    for (const write of state.writes) for (const secret of SECRETS) assert.ok(!write.includes(secret));
  });

  it("still connects when the account cannot be identified (identity is optional)", async () => {
    const { pending, sealed } = started();
    const { store, state } = memoryStore();
    const g = google({ token: exchangeOk, calendars: () => json({}, 503) });
    const outcome = await completeAuthorization(callbackDeps(store, g.fetch), { sealedState: sealed, state: pending.state, code: "4/FAKE", error: null, sessionUserId: USER_A });
    assert.deepEqual(outcome, { code: "conectado", stage: null });
    assert.equal(state.metadata?.accountEmail, null);
  });

  it("names each state failure, before calling Google", async () => {
    const { pending, sealed } = started();
    const old = started(USER_A, NOW - (OAUTH_STATE_TTL_SECONDS + 5) * 1000);
    const foreign: Keyring = { current: { id: "otherkey", key: randomBytes(32) }, previous: [] };
    const cases: [Partial<{ sealedState: string | undefined; state: string | null; code: string | null }>, string][] = [
      [{ sealedState: undefined }, "state_cookie_missing"],
      [{ sealedState: "" }, "state_cookie_missing"],
      [{ sealedState: tamper(sealed) }, "state_cookie_decrypt"],
      [{ sealedState: sealPendingAuthorization(pending, foreign) }, "state_cookie_decrypt"],
      [{ sealedState: encryptSecret("not json", keyring, "traza:google-oauth-state") }, "state_cookie_decrypt"],
      [{ sealedState: old.sealed, state: old.pending.state }, "state_expired"],
      [{ state: null }, "state_mismatch"],
      [{ state: "attacker-state" }, "state_mismatch"],
      [{ code: null }, "state_mismatch"],
    ];
    for (const [override, stage] of cases) {
      const g = google({ token: exchangeOk });
      const { store, state } = memoryStore();
      const outcome = await completeAuthorization(callbackDeps(store, g.fetch), {
        sealedState: sealed,
        state: pending.state,
        code: "4/FAKE",
        error: null,
        sessionUserId: USER_A,
        ...override,
      });
      assert.deepEqual(outcome, { code: "estado-invalido", stage }, stage);
      assert.equal(g.calls.length, 0, stage);
      assert.equal(state.credentials, null);
    }
  });

  it("refuses to complete a flow started by another TRAZA user (user_mismatch)", async () => {
    const g = google({ token: exchangeOk });
    const { store, state } = memoryStore();
    const { pending, sealed } = started(USER_A);
    const outcome = await completeAuthorization(callbackDeps(store, g.fetch), { sealedState: sealed, state: pending.state, code: "4/FAKE", error: null, sessionUserId: USER_B });
    assert.deepEqual(outcome, { code: "estado-invalido", stage: "user_mismatch" });
    assert.deepEqual([g.calls.length, state.credentials], [0, null]);
  });

  it("reports cancellation and other OAuth errors without storing anything", async () => {
    const { pending, sealed } = started();
    const { store, state } = memoryStore();
    const base = { sealedState: sealed, state: pending.state, code: null, sessionUserId: USER_A };
    assert.deepEqual(await completeAuthorization(callbackDeps(store, google().fetch), { ...base, error: "access_denied" }), { code: "cancelado", stage: "oauth_denied" });
    assert.deepEqual(await completeAuthorization(callbackDeps(store, google().fetch), { ...base, error: "server_error" }), { code: "error", stage: "oauth_error" });
    assert.equal(state.credentials, null);
  });

  it("reports a failed code exchange (token_exchange)", async () => {
    for (const token of [() => json({ error: "invalid_grant" }, 400), () => json({ error: "invalid_client" }, 401), () => json({}, 503)]) {
      const { pending, sealed } = started();
      const { store, state } = memoryStore();
      const outcome = await completeAuthorization(callbackDeps(store, google({ token }).fetch), { sealedState: sealed, state: pending.state, code: "used", error: null, sessionUserId: USER_A });
      assert.deepEqual(outcome, { code: "error-intercambio", stage: "token_exchange" });
      assert.equal(state.credentials, null);
    }
  });

  it("refuses partial consent or a missing refresh token, revoking what Google issued", async () => {
    for (const [token, expected, revoked] of [
      [() => json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: GOOGLE_CALENDAR_SCOPES[0] }), { code: "permisos-incompletos", stage: "scope_validation" }, REFRESH],
      [() => json({ access_token: ACCESS, expires_in: 3599, scope: GRANTED }), { code: "error-intercambio", stage: "refresh_token_missing" }, ACCESS],
    ] as const) {
      const { pending, sealed } = started();
      const { store, state } = memoryStore();
      const g = google({ token });
      assert.deepEqual(await completeAuthorization(callbackDeps(store, g.fetch), { sealedState: sealed, state: pending.state, code: "4/FAKE", error: null, sessionUserId: USER_A }), expected);
      assert.equal(state.credentials, null);
      assert.equal(g.calls.find((call) => call.url.endsWith("/revoke"))?.body.get("token"), revoked);
    }
  });

  it("names a failed encryption (token_encryption) and a failed write (database_store)", async () => {
    // The cookie opens with the real key (kept as "previous"); new ciphertext uses a broken current key.
    const brokenRing: Keyring = { current: { id: "brokenk1", key: Buffer.alloc(5) }, previous: [keyring.current] };
    const { pending, sealed } = started();
    const { store, state } = memoryStore();
    const outcome = await completeAuthorization(
      { config: { ...config, keyring: brokenRing }, store, fetch: google({ token: exchangeOk }).fetch, now: () => NOW },
      { sealedState: sealed, state: pending.state, code: "4/FAKE", error: null, sessionUserId: USER_A },
    );
    assert.deepEqual(outcome, { code: "error", stage: "token_encryption" });
    assert.equal(state.credentials, null);

    const failing = memoryStore();
    failing.store.saveConnection = async () => false;
    const second = started();
    assert.deepEqual(
      await completeAuthorization(callbackDeps(failing.store, google({ token: exchangeOk }).fetch), {
        sealedState: second.sealed,
        state: second.pending.state,
        code: "4/FAKE",
        error: null,
        sessionUserId: USER_A,
      }),
      { code: "error", stage: "database_store" },
    );
  });

  it("keeps the chosen calendar when the same account reconnects, clears it for another", async () => {
    const chosen = { ...connectedMeta, status: "revoked", selectedCalendarId: "traza123@group.calendar.google.com", selectedCalendarName: "TRAZA" };
    for (const [primary, kept] of [
      ["ana@example.com", true],
      ["otra@example.com", false],
    ] as const) {
      const { pending, sealed } = started();
      const { store, state } = memoryStore({ metadata: chosen });
      const g = google({ token: exchangeOk, calendars: () => json({ items: [{ id: primary, summary: primary, primary: true, accessRole: "owner" }] }) });
      const outcome = await completeAuthorization(callbackDeps(store, g.fetch), { sealedState: sealed, state: pending.state, code: "4/FAKE", error: null, sessionUserId: USER_A });
      assert.equal(outcome.code, "conectado");
      assert.equal(state.metadata?.selectedCalendarName ?? null, kept ? "TRAZA" : null, primary);
    }
  });
});

describe("callback redirect diagnostics", () => {
  it("adds google_error only in development, only for failures, only from the fixed list", () => {
    const failure = { code: "error", stage: "database_store" } as const;
    assert.equal(callbackRedirectSearch(failure, true).toString(), "google=error&google_error=database_store");
    assert.equal(callbackRedirectSearch(failure, false).toString(), "google=error");
    assert.equal(callbackRedirectSearch({ code: "conectado", stage: null }, true).toString(), "google=conectado");
    // A value outside the vocabulary is never echoed.
    assert.equal(callbackRedirectSearch({ code: "error", stage: "ya29.secret" as never }, true).toString(), "google=error");
  });

  it("uses a closed vocabulary that cannot carry secrets", () => {
    for (const stage of CALLBACK_STAGES) assert.match(stage, /^[a-z_]+$/);
    for (const required of [
      "session_missing",
      "state_cookie_missing",
      "state_cookie_decrypt",
      "state_expired",
      "state_mismatch",
      "user_mismatch",
      "oauth_denied",
      "token_exchange",
      "refresh_token_missing",
      "scope_validation",
      "google_calendar_identity",
      "token_encryption",
      "database_store",
      "unexpected",
    ]) {
      assert.ok(isCallbackStage(required), required);
    }
    assert.equal(isCallbackStage("1//0g-token"), false);
  });
});
