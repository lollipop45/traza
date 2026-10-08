// Automatic Google Calendar sync, end to end below the HTTP layer: the REAL leased runner, engine,
// planner, token refresh + encryption and retry layer, against the shared FAKE Google Calendar
// (tests/unit/helpers/google-fake.ts), an in-memory TRAZA with the database's link semantics and an
// in-memory lease store mirroring claim/finish_google_calendar_sync (the SQL itself is tested in
// tests/db). Virtual clock, fake secrets, no network, no real Google account.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  classifyGoogleSync,
  googleSyncLogLine,
  runLeasedGoogleSync,
  type GoogleSyncClaim,
  type GoogleSyncRecord,
  type LeasedGoogleSyncDeps,
} from "@/lib/google-calendar/auto-sync";
import { GOOGLE_AUTO_SYNC_HEADER, googleAutoSyncResponse } from "@/lib/google-calendar/auto-sync-request";
import { decryptSecret, tokenContext } from "@/lib/google-calendar/crypto";
import { readGoogleCalendarConfig } from "@/lib/google-calendar/env";
import { GOOGLE_MAX_RETRY_AFTER_MS, isRateLimit403, parseRetryAfter, withGoogleRetries } from "@/lib/google-calendar/http";
import { runGoogleSync, type GoogleSyncDeps } from "@/lib/google-calendar/sync";
import {
  GOOGLE_AUTO_SYNC_COOLDOWN_SECONDS,
  GOOGLE_AUTO_SYNC_INTERVAL_MS,
  GOOGLE_AUTO_SYNC_MIN_GAP_MS,
  GOOGLE_FAILURE_BACKOFF_SECONDS,
  GOOGLE_RECONNECT_BACKOFF_SECONDS,
  GOOGLE_SYNC_LEASE_SECONDS,
  googleNextEligibleSeconds,
  type GoogleSyncTrigger,
} from "@/lib/google-calendar/sync-policy";
import { googleSyncStatusView } from "@/lib/google-calendar/sync-status";
import { isSameOriginRequest } from "@/lib/security/same-origin";
import { ACCESS, CAL, GOOGLE_ERROR_TEXT, NEW_ACCESS, NOW, REFRESH, USER, config, independent, setup } from "./helpers/google-fake";

const MIN = 60_000;
const json = (body: unknown, status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

type FakeState = {
  lease_token: string | null;
  lease_until: number | null;
  next_eligible_at: number | null;
  consecutive_failures: number;
  last_result: string | null;
  last_success_at: number | null;
  record: GoogleSyncRecord | null;
};

function world(options: Parameters<typeof setup>[0] = {}) {
  const base = setup(options);
  let clock = NOW;
  let leases = 0;
  let enginesStarted = 0;
  const sleeps: number[] = [];
  const store = { state: null as FakeState | null, failFinish: false };

  const fetch = withGoogleRetries(base.google.fetch, {
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    now: () => clock,
  });
  const syncDeps = (automatic: boolean): GoogleSyncDeps => ({
    ...base.deps,
    connection: { ...base.deps.connection, fetch, now: () => clock, keepUnreadableCredentials: automatic },
  });

  /** Mirrors claim_google_calendar_sync / finish_google_calendar_sync. */
  const state = {
    async claim(trigger: GoogleSyncTrigger, leaseSeconds: number): Promise<GoogleSyncClaim | null> {
      store.state ??= { lease_token: null, lease_until: null, next_eligible_at: null, consecutive_failures: 0, last_result: null, last_success_at: null, record: null };
      const s = store.state;
      if (s.lease_until !== null && s.lease_until > clock) return { claimed: false, reason: "already_running", leaseToken: null, consecutiveFailures: s.consecutive_failures };
      if (trigger === "automatic" && s.next_eligible_at !== null && s.next_eligible_at > clock) return { claimed: false, reason: "not_due", leaseToken: null, consecutiveFailures: s.consecutive_failures };
      s.lease_token = `lease-${++leases}`;
      s.lease_until = clock + leaseSeconds * 1000;
      return { claimed: true, reason: "claimed", leaseToken: s.lease_token, consecutiveFailures: s.consecutive_failures };
    },
    async finish(token: string, record: GoogleSyncRecord): Promise<boolean> {
      if (store.failFinish) throw new Error("connection lost");
      const s = store.state;
      if (!s || s.lease_token !== token) return false;
      const success = record.result === "success";
      Object.assign(s, {
        lease_token: null,
        lease_until: null,
        last_result: record.result,
        last_success_at: success ? clock : s.last_success_at,
        consecutive_failures: success ? 0 : s.consecutive_failures + 1,
        next_eligible_at: clock + record.nextEligibleSeconds * 1000,
        record,
      });
      return true;
    },
  };

  const leased = (trigger: GoogleSyncTrigger, configured = true): LeasedGoogleSyncDeps => ({
    configured,
    loadMetadata: () => base.connection.store.loadMetadata(),
    state,
    createSync: () => {
      enginesStarted++;
      return syncDeps(trigger === "automatic");
    },
    now: () => clock,
  });

  const googleCalls = () => base.google.calls.length;
  return {
    ...base,
    store,
    sleeps,
    run: (trigger: GoogleSyncTrigger = "automatic", configured = true) => runLeasedGoogleSync(leased(trigger, configured), trigger),
    preview: () => runGoogleSync(syncDeps(false), "preview"),
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    googleCalls,
    tokenCalls: () => base.google.calls.filter((call) => call.method === "TOKEN").length,
    enginesStarted: () => enginesStarted,
    /** TRAZA-managed (mirror) Google events that are not cancelled. */
    mirrors: () => base.google.managed(),
  };
}

const afterCooldown = (w: ReturnType<typeof world>) => w.advance(GOOGLE_AUTO_SYNC_COOLDOWN_SECONDS * 1000 + 1);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("Google auto-sync: configuration", () => {
  it("missing credentials: safe credentials_missing, no Google call, the stored connection untouched", async () => {
    assert.deepEqual(readGoogleCalendarConfig({}), { ok: false, problem: "missing" });
    const w = world();
    w.traza.addEvent();
    const before = JSON.stringify(w.connection.state);
    const result = await w.run("automatic", false);
    assert.equal(result.outcome, "credentials_missing");
    assert.equal(w.googleCalls(), 0);
    assert.equal(w.store.state, null, "no lease, no state row");
    assert.equal(JSON.stringify(w.connection.state), before);
  });

  it("each required variable is needed; the encryption key must be 32 bytes", () => {
    const full = {
      GOOGLE_CLIENT_ID: "123456789012-fakeclientid.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "GOCSPX-FAKE-client-secret-not-real",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/api/integrations/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    assert.equal(readGoogleCalendarConfig(full).ok, true);
    for (const name of Object.keys(full)) {
      const partial: Record<string, string> = { ...full };
      delete partial[name];
      assert.deepEqual(readGoogleCalendarConfig(partial), { ok: false, problem: "missing" }, name);
    }
    assert.deepEqual(readGoogleCalendarConfig({ ...full, GOOGLE_TOKEN_ENCRYPTION_KEY: "short" }), { ok: false, problem: "invalid-encryption-key" });
  });

  it("credentials present: the connection lookup proceeds and the sync runs", async () => {
    const w = world();
    w.traza.addEvent();
    const result = await w.run();
    assert.equal(result.outcome, "success");
    assert.equal(result.created, 1);
  });

  it("a different encryption key: the automatic sync reports reconnect_required and never wipes the stored tokens", async () => {
    const w = world();
    const otherKey = readGoogleCalendarConfig({
      GOOGLE_CLIENT_ID: "123456789012-fakeclientid.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "GOCSPX-FAKE-client-secret-not-real",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/api/integrations/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });
    assert.ok(otherKey.ok);
    w.deps.connection.config = otherKey.config; // the run decrypts with a key that does not match
    w.connection.state.credentials = { ...w.connection.state.credentials!, accessExpiresAt: new Date(NOW - MIN).toISOString() };
    const before = JSON.stringify(w.connection.state.credentials);
    const result = await w.run();
    assert.equal(result.outcome, "reconnect_required");
    assert.equal(w.connection.state.metadata.status, "connected");
    assert.equal(JSON.stringify(w.connection.state.credentials), before, "restoring the right key recovers the connection");
    assert.equal(w.tokenCalls(), 0);
    assert.equal(w.store.state?.record?.result, "reconnect_required");
  });
});

// ---------------------------------------------------------------------------
// State, cooldown, lease
// ---------------------------------------------------------------------------

describe("Google auto-sync: state and cooldown", () => {
  it("first automatic sync is due; success establishes the 15-minute cooldown", async () => {
    const w = world();
    assert.equal((await w.run()).outcome, "success");
    assert.equal(w.store.state!.next_eligible_at! - w.now(), 15 * MIN);
    assert.equal(w.store.state!.lease_until, null);
  });

  it("inside the cooldown automatic checks return not_due without calling Google; manual runs", async () => {
    const w = world();
    await w.run();
    const calls = w.googleCalls();
    for (let i = 0; i < 6; i++) {
      w.advance(2 * MIN);
      assert.equal((await w.run()).outcome, "not_due");
    }
    assert.equal(w.googleCalls(), calls);
    assert.equal(w.enginesStarted(), 1);
    assert.equal((await w.run("manual")).outcome, "success");
    assert.ok(w.googleCalls() > calls);
  });

  it("temporary failures back off 5, 10, 20, 40, 60 minutes; reconnect_required much longer", async () => {
    const w = world();
    w.google.state.down = true;
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      assert.equal((await w.run()).outcome, "temporary_error");
      waits.push((w.store.state!.next_eligible_at! - w.now()) / 1000);
      w.advance(w.store.state!.next_eligible_at! - w.now() + 1);
    }
    assert.deepEqual(waits, [300, 600, 1200, 2400, 3600, 3600]);
    assert.deepEqual(FAILURE_LADDER, [...GOOGLE_FAILURE_BACKOFF_SECONDS]);
    assert.equal(googleNextEligibleSeconds("reconnect_required", 0), GOOGLE_RECONNECT_BACKOFF_SECONDS);
    assert.ok(GOOGLE_RECONNECT_BACKOFF_SECONDS >= 6 * 3600);
    w.google.state.down = false;
    assert.equal((await w.run()).outcome, "success");
    assert.equal(w.store.state!.consecutive_failures, 0);
  });

  it("a crashed run blocks only until its lease expires", async () => {
    const w = world();
    w.store.failFinish = true;
    await w.run();
    w.store.failFinish = false;
    assert.equal((await w.run("manual")).outcome, "already_running");
    w.advance(GOOGLE_SYNC_LEASE_SECONDS * 1000);
    assert.equal((await w.run("manual")).outcome, "success");
  });

  it("not connected, revoked, or no calendar: answered before any lease or Google call", async () => {
    for (const [metadata, outcome] of [
      [{ selectedCalendarId: null, selectedCalendarName: null }, "no_calendar"],
      [{ status: "revoked" }, "reconnect_required"],
    ] as const) {
      const w = world({ metadata });
      assert.equal((await w.run()).outcome, outcome);
      assert.equal(w.googleCalls(), 0);
      assert.equal(w.store.state, null);
    }
    const w = world();
    w.connection.state.metadata = null as never;
    w.connection.store.loadMetadata = async () => ({ ok: true, metadata: null });
    assert.equal((await w.run()).outcome, "not_connected");
  });
});

const FAILURE_LADDER = [300, 600, 1200, 2400, 3600];

describe("Google auto-sync: concurrency (database lease)", () => {
  function gated(w: ReturnType<typeof world>) {
    let release!: () => void;
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    w.google.state.beforeRequest = async () => {
      if (held) return;
      held = true;
      reached();
      await gate;
    };
    return { atGate, release };
  }

  it("two tabs: one Google caller; manual during automatic is refused; one token refresh", async () => {
    const w = world({ accessValidFor: 0 });
    w.traza.addEvent();
    const { atGate, release } = gated(w);
    const tabA = w.run();
    await atGate;
    const callsWhileA = w.googleCalls();
    assert.equal((await w.run()).outcome, "already_running");
    assert.equal((await w.run("manual")).outcome, "already_running");
    assert.equal(w.googleCalls(), callsWhileA, "B never called Google");
    release();
    assert.equal((await tabA).outcome, "success");
    assert.equal(w.tokenCalls(), 1, "tokens are refreshed once, by the lease holder");
    assert.equal(w.mirrors().length, 1);
  });

  it("an automatic run during a manual one is refused", async () => {
    const w = world();
    const { atGate, release } = gated(w);
    const manual = w.run("manual");
    await atGate;
    assert.equal((await w.run()).outcome, "already_running");
    release();
    assert.equal((await manual).outcome, "success");
  });
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe("Google auto-sync: token refresh", () => {
  it("a valid stored token is used as is", async () => {
    const w = world();
    await w.run();
    assert.equal(w.tokenCalls(), 0);
    assert.ok(w.google.calls.every((call) => call.method === "TOKEN" || call.auth === `Bearer ${ACCESS}`));
  });

  it("an expired token is refreshed server-side, stored encrypted, and the sync then succeeds", async () => {
    const w = world({ accessValidFor: 0 });
    w.traza.addEvent();
    const result = await w.run();
    assert.equal(result.outcome, "success");
    assert.equal(w.tokenCalls(), 1);
    const stored = w.connection.state.credentials!;
    assert.ok(!stored.accessCiphertext!.includes(NEW_ACCESS));
    assert.equal(decryptSecret(stored.accessCiphertext!, config.keyring, tokenContext(USER, "access")), NEW_ACCESS);
    assert.ok(w.google.calls.filter((call) => call.method !== "TOKEN").every((call) => call.auth === `Bearer ${NEW_ACCESS}`));
  });

  it("invalid_grant: reconnect_required, connection marked for reconnection, TRAZA data intact, no token anywhere", async () => {
    const w = world({ accessValidFor: 0 });
    w.traza.addEvent();
    w.google.add(independent("g1"));
    await w.run("manual");
    afterCooldown(w);
    w.connection.state.credentials = { ...w.connection.state.credentials!, accessExpiresAt: new Date(w.now() - MIN).toISOString() };
    w.google.state.refreshRevoked = true;
    const before = JSON.stringify(w.traza.db.events);
    const result = await w.run();
    assert.equal(result.outcome, "reconnect_required");
    assert.equal(w.connection.state.metadata.status, "revoked");
    assert.equal(JSON.stringify(w.traza.db.events), before, "imported Google events are kept");
    for (const text of [JSON.stringify(result), googleSyncLogLine(result), JSON.stringify(w.store.state)]) {
      for (const secret of [ACCESS, NEW_ACCESS, REFRESH, GOOGLE_ERROR_TEXT, config.clientSecret]) assert.ok(!text.includes(secret), secret);
    }
    // Afterwards nothing hammers Google: the revoked connection is answered before any call.
    const calls = w.googleCalls();
    w.advance(24 * 60 * MIN);
    assert.equal((await w.run()).outcome, "reconnect_required");
    assert.equal(w.googleCalls(), calls);
  });
});

// ---------------------------------------------------------------------------
// TRAZA → Google and Google → TRAZA through the automatic path (same engine)
// ---------------------------------------------------------------------------

describe("Google auto-sync: TRAZA → Google", () => {
  it("a local event creates one mirror and an edit updates that same mirror", async () => {
    const w = world();
    const event = w.traza.addEvent();
    await w.run();
    assert.equal(w.mirrors().length, 1);
    const id = w.mirrors()[0].id;
    event.title = "Revisión final";
    afterCooldown(w);
    const result = await w.run();
    assert.equal(result.updated, 1);
    assert.deepEqual(
      w.mirrors().map((m) => [m.id, m.summary]),
      [[id, "Revisión final"]],
    );
  });

  it("tasks: dated → one all-day mirror (no invented time); undated → none; losing the date removes it; completion keeps it", async () => {
    const w = world();
    const dated = w.traza.addTask({ title: "Entrega panel", due_date: "2026-10-20" });
    w.traza.addTask({ title: "Sin fecha", due_date: null });
    await w.run();
    assert.equal(w.mirrors().length, 1);
    const mirror = w.mirrors()[0] as unknown as { start: Record<string, unknown> };
    assert.deepEqual(mirror.start, { date: "2026-10-20" });

    dated.status = "done";
    afterCooldown(w);
    await w.run();
    assert.equal(w.mirrors().length, 1, "a completed task keeps its mirror");

    dated.due_date = null;
    afterCooldown(w);
    const removed = await w.run();
    assert.equal(removed.deleted, 1);
    assert.equal(w.mirrors().length, 0);
  });

  it("a deleted local item's mirror is cleaned up through its tombstone", async () => {
    const w = world();
    const event = w.traza.addEvent();
    await w.run();
    w.traza.deleteItem(event.id);
    afterCooldown(w);
    const result = await w.run();
    assert.equal(result.deleted, 1);
    assert.equal(w.mirrors().length, 0);
    assert.equal(w.traza.db.links.length, 0);
  });

  it("a Canvas task is mirrored once and Google never writes back into it", async () => {
    const w = world();
    const task = w.traza.addTask({ title: "Panel análisis territorial", source: "canvas", due_date: "2026-10-12" });
    for (let i = 0; i < 3; i++) {
      await w.run(i === 1 ? "manual" : "automatic");
      afterCooldown(w);
    }
    assert.equal(w.mirrors().length, 1);
    // Someone edits the mirror in Google: TRAZA restores its own values; the task is untouched.
    const mirror = w.mirrors()[0];
    w.google.events.set(mirror.id, { ...mirror, summary: "Editado en Google" });
    await w.run();
    assert.equal(task.title, "Panel análisis territorial");
    assert.equal(w.mirrors()[0].summary, "Panel análisis territorial");
    assert.equal(w.traza.db.tasks.length, 1);
  });
});

describe("Google auto-sync: Google → TRAZA", () => {
  it("imports timed events in Atlantic/Canary time and all-day events without shifting the date; no project guessing", async () => {
    const w = world();
    w.google.add(independent("timed1", { start: { dateTime: "2026-10-14T08:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-14T10:00:00Z", timeZone: "UTC" } }));
    w.google.add(independent("allday1", { summary: "Festivo", start: { date: "2026-10-15" }, end: { date: "2026-10-16" } }));
    const result = await w.run();
    assert.equal(result.imported, 2);
    const byTitle = new Map(w.traza.db.events.map((e) => [e.title, e]));
    const timed = byTitle.get("Clase de estructuras")!;
    assert.deepEqual([timed.event_date, timed.start_time, timed.end_time, timed.all_day], ["2026-10-14", "09:00:00", "11:00:00", false]);
    const allDay = byTitle.get("Festivo")!;
    assert.deepEqual([allDay.event_date, allDay.all_day, allDay.start_time], ["2026-10-15", true, null]);
    assert.ok(w.traza.db.events.every((e) => e.project_id === null));
  });

  it("a recurring occurrence stays one TRAZA event across runs, and imported events are never re-exported", async () => {
    const w = world();
    w.google.add(independent("serie1_20261014T080000Z", { recurringEventId: "serie1" }));
    for (let i = 0; i < 4; i++) {
      await w.run(i % 2 ? "manual" : "automatic");
      afterCooldown(w);
    }
    assert.equal(w.traza.db.events.length, 1);
    assert.equal(w.google.writes().length, 0, "no Google write for a Google-origin event");
    assert.equal(w.mirrors().length, 0);
  });

  it("a Google event missing from one listing is not deleted from TRAZA", async () => {
    const w = world();
    w.google.add(independent("g1"));
    await w.run();
    w.google.events.delete("g1");
    afterCooldown(w);
    const result = await w.run();
    assert.equal(result.outcome, "success");
    assert.equal(w.traza.db.events.length, 1);
  });
});

describe("Google auto-sync: Atlantic/Canary dates whatever the server zone", () => {
  it("midnight and the October DST change, with the process forced to UTC+14", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      const w = world();
      w.google.add(independent("a", { summary: "Antes", start: { dateTime: "2026-10-24T23:30:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-24T23:45:00Z", timeZone: "UTC" } }));
      w.google.add(independent("b", { summary: "Después", start: { dateTime: "2026-10-25T23:30:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-25T23:45:00Z", timeZone: "UTC" } }));
      await w.run();
      const byTitle = new Map(w.traza.db.events.map((e) => [e.title, [e.event_date, e.start_time]]));
      assert.deepEqual(byTitle.get("Antes"), ["2026-10-25", "00:30:00"], "summer time: UTC+1");
      assert.deepEqual(byTitle.get("Después"), ["2026-10-25", "23:30:00"], "winter time: UTC+0");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("Google auto-sync: idempotency", () => {
  function populated() {
    const w = world();
    w.traza.addEvent();
    w.traza.addTask();
    w.traza.addTask({ title: "Canvas", source: "canvas", due_date: "2026-10-22" });
    w.google.add(independent("g1"));
    return w;
  }
  const shape = (w: ReturnType<typeof world>) => ({ mirrors: w.mirrors().length, links: w.traza.db.links.length, events: w.traza.db.events.length });

  it("ten unchanged automatic syncs: one mirror per item, one TRAZA event per Google event", async () => {
    const w = populated();
    for (let i = 0; i < 10; i++) {
      await w.run();
      afterCooldown(w);
    }
    assert.deepEqual(shape(w), { mirrors: 3, links: 3, events: 2 });
    assert.equal(w.store.state?.record?.unchanged, 4);
  });

  it("manual then automatic, and automatic then manual, never duplicate", async () => {
    for (const order of [
      ["manual", "automatic"],
      ["automatic", "manual"],
    ] as const) {
      const w = populated();
      await w.run(order[0]);
      afterCooldown(w);
      const second = await w.run(order[1]);
      assert.deepEqual([second.created, second.imported], [0, 0], order.join(" → "));
      assert.deepEqual(shape(w), { mirrors: 3, links: 3, events: 2 });
    }
  });

  it("a retry after 503 (inside one run, and as a later run) creates no duplicate", async () => {
    const w = populated();
    w.google.state.script = (kind, n) => (kind === "POST" && n === 1 ? json({ error: GOOGLE_ERROR_TEXT }, 503) : undefined);
    assert.equal((await w.run()).outcome, "success");
    assert.deepEqual(shape(w), { mirrors: 3, links: 3, events: 2 });

    const v = populated();
    v.google.state.failWritesAfter = 1;
    assert.equal((await v.run()).outcome, "temporary_error");
    v.google.state.failWritesAfter = Infinity;
    v.advance(6 * MIN);
    assert.equal((await v.run()).outcome, "success");
    assert.deepEqual(shape(v), { mirrors: 3, links: 3, events: 2 });
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("Google auto-sync: failures and retries", () => {
  it("429 is retried after its Retry-After; a too-long Retry-After is not waited for", async () => {
    const w = world();
    w.google.state.script = (kind, n) => (kind === "GET" && n === 1 ? json({}, 429, { "Retry-After": "2" }) : undefined);
    assert.equal((await w.run()).outcome, "success");
    assert.ok(w.sleeps.includes(2000));

    const v = world();
    v.google.state.script = (kind) => (kind === "GET" ? json({}, 429, { "Retry-After": "120" }) : undefined);
    const result = await v.run();
    assert.equal(result.outcome, "rate_limited");
    assert.equal(v.google.calls.filter((c) => c.method === "GET").length, 1);
    assert.ok(GOOGLE_MAX_RETRY_AFTER_MS <= 10_000);
  });

  it("a rate-limit 403 is treated as a rate limit (retried), not as lost access", async () => {
    const reason = (r: string) => json({ error: { code: 403, errors: [{ reason: r, message: GOOGLE_ERROR_TEXT }] } }, 403);
    assert.equal(await isRateLimit403(reason("userRateLimitExceeded")), true);
    assert.equal(await isRateLimit403(reason("forbidden")), false);
    const w = world();
    w.google.state.script = (kind, n) => (kind === "GET" && n === 1 ? reason("rateLimitExceeded") : undefined);
    assert.equal((await w.run()).outcome, "success");
    assert.equal(w.connection.state.metadata.status, "connected");
  });

  it("503, timeouts and network errors are retried (3 attempts) and then recover", async () => {
    for (const failure of [json({}, 503), "timeout", "network"] as const) {
      const w = world();
      w.google.state.script = (kind, n) => (kind === "GET" && n <= 2 ? failure : undefined);
      assert.equal((await w.run()).outcome, "success", String(failure));
      assert.deepEqual(w.sleeps, [500, 1000]);
    }
    const w = world();
    w.google.state.script = (kind) => (kind === "GET" ? "timeout" : undefined);
    assert.equal((await w.run()).outcome, "temporary_error");
    assert.equal(w.store.state?.lease_until, null, "the lease is released after a timeout");
  });

  it("a permanent 400 is not retried; a permanent 403 is a safe reconnect_required", async () => {
    const w = world();
    w.google.state.script = (kind) => (kind === "GET" ? json({ error: GOOGLE_ERROR_TEXT }, 400) : undefined);
    const bad = await w.run();
    assert.equal(bad.outcome, "temporary_error");
    assert.equal(w.store.state?.record?.result, "unexpected");
    assert.equal(w.google.calls.filter((c) => c.method === "GET").length, 1);

    const v = world();
    v.google.state.script = (kind) => (kind === "GET" ? json({ error: { errors: [{ reason: "forbidden" }] } }, 403) : undefined);
    const forbidden = await v.run();
    assert.equal(forbidden.outcome, "reconnect_required");
    assert.equal(v.google.calls.filter((c) => c.method === "GET").length, 2, "one retry with a refreshed token, then stop");
    assert.ok(!JSON.stringify(forbidden).includes(GOOGLE_ERROR_TEXT));
  });

  it("a malformed Google response writes nothing", async () => {
    const w = world();
    w.traza.addEvent();
    await w.run();
    const before = JSON.stringify(w.traza.db);
    w.google.state.script = (kind) => (kind === "GET" ? new Response("<html>oops</html>", { status: 200 }) : undefined);
    afterCooldown(w);
    const result = await w.run();
    assert.equal(result.outcome, "temporary_error");
    assert.equal(JSON.stringify(w.traza.db), before);
  });

  it("Retry-After parsing is bounded and safe", () => {
    assert.equal(parseRetryAfter("3", 0), 3000);
    assert.equal(parseRetryAfter(null, 0), null);
    assert.equal(parseRetryAfter("soon", 0), null);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  });

  it("classifies engine results into safe outcomes", () => {
    assert.deepEqual(classifyGoogleSync({ ok: false, error: "x", code: "unexpected" }), { outcome: "temporary_error", record: "unexpected" });
    assert.deepEqual(classifyGoogleSync({ ok: false, error: "x", code: "rate_limited" }), { outcome: "rate_limited", record: "rate_limited" });
  });
});

// ---------------------------------------------------------------------------
// Endpoint, security, triggers, status
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
/** Source without line comments, so scans look at code, not at the words used to document it. */
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, "");
function files(dir: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, accept) : accept(full) ? [full] : [];
  });
}

describe("Google auto-sync: endpoint and security", () => {
  const good = { [GOOGLE_AUTO_SYNC_HEADER]: "1", origin: "https://traza.example.com", host: "traza.example.com", "sec-fetch-site": "same-origin" };
  const check = (headers: Record<string, string>) => isSameOriginRequest(new Headers(headers), GOOGLE_AUTO_SYNC_HEADER);

  it("accepts only same-origin POSTs with the Google header (the Canvas header is not enough)", () => {
    assert.equal(check(good), true);
    assert.equal(check({ ...good, origin: "https://evil.example.com" }), false);
    assert.equal(check({ ...good, "sec-fetch-site": "cross-site" }), false);
    assert.equal(check(Object.fromEntries(Object.entries(good).filter(([key]) => key !== GOOGLE_AUTO_SYNC_HEADER))), false);
    assert.equal(check({ ...Object.fromEntries(Object.entries(good).filter(([key]) => key !== GOOGLE_AUTO_SYNC_HEADER)), "x-traza-auto-sync": "1" }), false);
  });

  it("the endpoint is POST only, checks origin then session, never reads the body, and answers an enum + boolean", async () => {
    const route = code("app/api/integrations/google/auto-sync/route.ts");
    assert.match(route, /export async function POST\(/);
    assert.doesNotMatch(route, /export (async )?function (GET|PUT|PATCH|DELETE)\b/);
    assert.match(route, /isSameOriginRequest\(request\.headers, GOOGLE_AUTO_SYNC_HEADER\)/);
    assert.match(route, /if \(!user\) return json\(\{ error: "unauthorized" \}, 401\)/);
    assert.match(route, /createLeasedGoogleSyncDeps\(user\.id, "automatic"\)/);
    assert.doesNotMatch(route, /request\.(json|text|formData|arrayBuffer|body)|searchParams|calendarId|eventId|projectId|token/i);
    const w = world();
    w.google.add(independent("g1"));
    assert.deepEqual(googleAutoSyncResponse(await w.run()), { outcome: "success", changed: true });
    w.advance(MIN);
    assert.deepEqual(googleAutoSyncResponse(await w.run()), { outcome: "not_due", changed: false });
  });

  it("the state functions take no user id; the store sends none", () => {
    assert.doesNotMatch(read("lib/google-calendar/sync-state-store.ts"), /p_user/);
    const migration = read("supabase/migrations/20261007103558_google_calendar_sync_state.sql");
    assert.doesNotMatch(migration, /p_user_id/);
    assert.match(migration, /enable row level security/);
    assert.doesNotMatch(migration, /token_ciphertext/, "the sync state functions never read tokens");
  });

  it("the development log line carries enums and counts only", async () => {
    const w = world();
    w.traza.addEvent({ title: "Reunión privada" });
    const line = googleSyncLogLine(await w.run());
    assert.match(line, /^TRAZA Google auto-sync: outcome=success trigger=automatic created=1 updated=0 imported=0 deleted=0 unchanged=0 failed=0 duration=\d+ms$/);
    for (const secret of ["Reunión privada", CAL, USER, ACCESS, "ana@example.com"]) assert.ok(!line.includes(secret), secret);
  });

  it("no client code can reach Google secrets or tokens; no service role anywhere", () => {
    const sources = ["app", "components", "lib"].flatMap((dir) => files(path.join(ROOT, dir), (f) => /\.tsx?$/.test(f)));
    const client = sources.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    assert.ok(client.some((f) => f.endsWith("GoogleCalendarAutoSyncTrigger.tsx")));
    for (const file of client) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /@\/lib\/google-calendar\/(env|crypto|connection|oauth|store|sync-store|sync-deps|sync-state-store|queries|http|events|client)["']/, path.relative(ROOT, file));
      assert.doesNotMatch(text, /GOOGLE_CLIENT_SECRET|GOOGLE_TOKEN_ENCRYPTION_KEY|refresh_token|access_token/, path.relative(ROOT, file));
    }
    for (const file of ["lib/google-calendar/sync-deps.ts", "lib/google-calendar/sync-state-store.ts", "lib/google-calendar/queries.ts"]) assert.match(read(file), /^import "server-only";/, file);
    assert.doesNotMatch(sources.map((f) => readFileSync(f, "utf8")).join("\n"), /SERVICE_ROLE|service_role_key|serviceRole/i);
  });

  it("the built browser bundle (if present) contains no Google secret names, token endpoints or sync internals", () => {
    const bundle = files(path.join(ROOT, ".next", "static"), (f) => f.endsWith(".js"));
    if (bundle.length === 0) return;
    const text = bundle.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const needle of ["GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY", "oauth2.googleapis.com", "claim_google_calendar_sync", "finish_google_calendar_sync", "TRAZA Google auto-sync"]) {
      assert.ok(!text.includes(needle), needle);
    }
  });
});

describe("Google auto-sync: triggers", () => {
  it("both triggers live in the private layout only, as independent components", () => {
    const layout = read("app/(app)/layout.tsx");
    assert.match(layout, /await requireUser\(\)/);
    assert.match(layout, /isCanvasConfigured\(\) && <CanvasAutoSyncTrigger \/>/);
    assert.match(layout, /isGoogleCalendarConfigured\(\) && <GoogleCalendarAutoSyncTrigger \/>/);
    assert.doesNotMatch(layout, /await .*(Sync|sync)\(/, "the layout never waits for a sync");
    for (const file of [...files(path.join(ROOT, "app", "login"), () => true), path.join(ROOT, "app", "layout.tsx")]) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /AutoSyncTrigger/, path.relative(ROOT, file));
    }
  });

  it("the Google trigger is bounded: POST without body, ~10-minute interval, visibility-aware, shared across tabs", () => {
    const trigger = code("components/calendar/GoogleCalendarAutoSyncTrigger.tsx");
    const request = trigger.match(/fetch\(GOOGLE_AUTO_SYNC_PATH, \{([^}]*\})[^}]*\}\)/)?.[1] ?? "";
    assert.match(request, /method: "POST"/);
    assert.doesNotMatch(request, /body/);
    assert.match(trigger, /document\.visibilityState !== "visible"/);
    assert.match(trigger, /visibilitychange/);
    assert.match(trigger, /localStorage/);
    assert.equal(GOOGLE_AUTO_SYNC_INTERVAL_MS, 10 * MIN);
    assert.ok(GOOGLE_AUTO_SYNC_MIN_GAP_MS >= 60_000);
    assert.doesNotMatch(trigger, /toast|alert\(|Notification/);
  });
});

describe("Google auto-sync: Calendar status", () => {
  const connected = { state: "connected" as const, accountEmail: "ana@example.com", calendarName: "TRAZA" };
  const row = (fields: Partial<{ lease_until: string | null; last_success_at: string | null; last_result: string | null }>) => ({ lease_until: null, last_success_at: null, last_result: null, ...fields });
  const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();

  it("shows a restrained state, never details", () => {
    assert.equal(googleSyncStatusView({ state: "not-configured" }, null, NOW).status, "NO CONFIGURADO");
    assert.equal(googleSyncStatusView({ state: "disconnected" }, null, NOW).status, "NO CONECTADO");
    assert.deepEqual(googleSyncStatusView({ ...connected, state: "revoked" }, null, NOW), { status: "REQUIERE RECONECTAR", lastSync: "Nunca", reconnect: true });
    assert.deepEqual(googleSyncStatusView(connected, row({ last_result: "success", last_success_at: ago(12) }), NOW), { status: "ACTUALIZADO", lastSync: "Hace 12 min", reconnect: false });
    assert.equal(googleSyncStatusView(connected, row({ lease_until: new Date(NOW + MIN).toISOString() }), NOW).status, "EN CURSO");
    assert.equal(googleSyncStatusView(connected, row({ last_result: "rate_limited" }), NOW).status, "ERROR TEMPORAL");
    assert.equal(googleSyncStatusView(connected, row({ last_result: "reconnect_required" }), NOW).reconnect, true);
    assert.equal(googleSyncStatusView(connected, null, NOW).status, "SIN SINCRONIZAR");
  });
});
