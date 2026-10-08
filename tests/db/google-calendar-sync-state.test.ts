// Database-level guarantees of public.google_calendar_sync_state and its two functions: owner-only
// reads, no direct writes, an atomic per-user lease, cooldown / backoff bookkeeping, a reconnection
// lifting the backoff, and cross-user isolation (including B never touching A's connection).
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;

type Claim = { claimed: boolean; reason: string; lease_token: string | null; consecutive_failures: number };

const CIPHER = "v1.k1.AAAAAAAAAAAAAAAA.cmVmcmVzaC1BLWNpcGhlcnRleHQtZmFrZQ";
const claim = (trigger: "automatic" | "manual", lease = 300) => `select * from public.claim_google_calendar_sync('${trigger}', ${lease})`;
const finish = (token: string, result: string, seconds: number, counts = "") =>
  `select public.finish_google_calendar_sync('${token}', '${result}', ${seconds}${counts}) as ok`;
const state = `select lease_until is not null as leased, last_result, consecutive_failures, last_success_at is not null as succeeded,
                      round(extract(epoch from (next_eligible_at - now())))::int as next_in
                 from public.google_calendar_sync_state`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

/** Moves a clock-dependent column into the past (as the table owner), simulating elapsed time. */
const age = (userId: string, column: "lease_until" | "next_eligible_at" | "last_finished_at", seconds: number) =>
  db.exec(`update public.google_calendar_sync_state set ${column} = now() - interval '${seconds} seconds' where user_id = '${userId}'`);

beforeEach(async () => {
  db = await createDatabase();
});

describe("google_calendar_sync_state: access", () => {
  it("has RLS enabled and gives anon nothing", async () => {
    const [{ rls }] = await as<{ rls: boolean }>(db, "authenticated", USER_A, `select relrowsecurity as rls from pg_class where oid = 'public.google_calendar_sync_state'::regclass`);
    assert.equal(rls, true);
    await rejects(as(db, "anon", null, `select * from public.google_calendar_sync_state`), /permission denied/);
    await rejects(as(db, "anon", null, claim("automatic")), /permission denied/);
    await rejects(as(db, "anon", null, finish("00000000-0000-4000-8000-000000000000", "success", 900)), /permission denied/);
    await rejects(as(db, "authenticated", null, claim("automatic")), /Not authenticated/);
  });

  it("is read-only for clients, and the lease token is not readable", async () => {
    await commitAs(db, "authenticated", USER_A, claim("automatic"));
    await rejects(as(db, "authenticated", USER_A, `insert into public.google_calendar_sync_state (user_id) values ('${USER_A}')`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_sync_state set next_eligible_at = null`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_sync_state set lease_until = null`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `delete from public.google_calendar_sync_state`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `select lease_token from public.google_calendar_sync_state`), /permission denied/);
  });

  it("isolates users: B sees nothing of A, has its own lease, cannot finish A's, and cannot read A's connection", async () => {
    await commitAs(db, "authenticated", USER_A, `insert into public.google_calendar_connections (refresh_token_ciphertext) values ('${CIPHER}')`);
    const [a] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.deepEqual(await as(db, "authenticated", USER_B, `select user_id from public.google_calendar_sync_state`), []);
    const [b] = await as<Claim>(db, "authenticated", USER_B, claim("automatic"));
    assert.equal(b.claimed, true);
    const [{ ok }] = await as<{ ok: boolean }>(db, "authenticated", USER_B, finish(a.lease_token!, "success", 900));
    assert.equal(ok, false);
    assert.deepEqual(await as(db, "authenticated", USER_B, `select id, status from public.google_calendar_connections`), []);
    assert.deepEqual(await as(db, "authenticated", USER_B, `select * from public.get_google_calendar_credentials()`), []);
    const [{ leased }] = await as<{ leased: boolean }>(db, "authenticated", USER_A, state);
    assert.equal(leased, true);
  });

  it("validates its arguments; results and counts come from a fixed vocabulary", async () => {
    await rejects(as(db, "authenticated", USER_A, `select * from public.claim_google_calendar_sync('cron', 300)`), /Invalid trigger/);
    await rejects(as(db, "authenticated", USER_A, claim("automatic", 5)), /Invalid lease/);
    const [{ lease_token }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await rejects(as(db, "authenticated", USER_A, finish(lease_token!, "Google said: invalid_grant for ana@example.com", 900)), /google_calendar_sync_state_result_valid/);
    await rejects(as(db, "authenticated", USER_A, finish(lease_token!, "success", 5)), /Invalid next eligible/);
    await rejects(as(db, "authenticated", USER_A, finish(lease_token!, "success", 900, ", -1")), /google_calendar_sync_state_counts_range/);
  });
});

describe("google_calendar_sync_state: lease", () => {
  it("first automatic sync is due and takes the lease", async () => {
    const [first] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.deepEqual([first.claimed, first.reason], [true, "claimed"]);
    assert.match(first.lease_token ?? "", /^[0-9a-f-]{36}$/);
  });

  it("tab A claims; tab B and a manual sync are refused while A runs; after A finishes manual may run", async () => {
    const [a] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    for (const trigger of ["automatic", "manual"] as const) {
      const [other] = await commitAs<Claim>(db, "authenticated", USER_A, claim(trigger));
      assert.deepEqual([other.claimed, other.reason, other.lease_token], [false, "already_running", null], trigger);
    }
    const [{ ok }] = await commitAs<{ ok: boolean }>(db, "authenticated", USER_A, finish(a.lease_token!, "success", 900, ", 1, 2, 3, 4, 5, 0"));
    assert.equal(ok, true);
    const [counts] = await as(db, "authenticated", USER_A, `select last_created_count, last_updated_count, last_imported_count, last_deleted_count, last_unchanged_count, last_failed_count, lease_until from public.google_calendar_sync_state`);
    assert.deepEqual(counts, { last_created_count: 1, last_updated_count: 2, last_imported_count: 3, last_deleted_count: 4, last_unchanged_count: 5, last_failed_count: 0, lease_until: null });
    const [auto] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(auto.reason, "not_due");
    const [manual] = await commitAs<Claim>(db, "authenticated", USER_A, claim("manual"));
    assert.equal(manual.claimed, true);
  });

  it("an automatic sync during a manual one is refused too", async () => {
    await commitAs<Claim>(db, "authenticated", USER_A, claim("manual"));
    const [auto] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(auto.reason, "already_running");
  });

  it("a stale lease is reclaimed; the crashed holder can no longer finish", async () => {
    const [crashed] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await age(USER_A, "lease_until", 1);
    const [next] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(next.claimed, true);
    const [{ ok }] = await as<{ ok: boolean }>(db, "authenticated", USER_A, finish(crashed.lease_token!, "success", 900));
    assert.equal(ok, false);
  });

  it("concurrent claims: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"))));
    assert.equal(results.filter(([row]) => row.claimed).length, 1);
  });
});

describe("google_calendar_sync_state: cooldown and backoff", () => {
  it("success sets the cooldown; once it has passed, automatic is due again", async () => {
    const [{ lease_token }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await commitAs(db, "authenticated", USER_A, finish(lease_token!, "success", 900));
    const [row] = await as(db, "authenticated", USER_A, state);
    assert.deepEqual(row, { leased: false, last_result: "success", consecutive_failures: 0, succeeded: true, next_in: 900 });
    assert.equal((await as<Claim>(db, "authenticated", USER_A, claim("automatic")))[0].reason, "not_due");
    await age(USER_A, "next_eligible_at", 1);
    assert.equal((await as<Claim>(db, "authenticated", USER_A, claim("automatic")))[0].claimed, true);
  });

  it("failures count up with the given backoff and keep the last success time", async () => {
    const [{ lease_token: t1 }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await commitAs(db, "authenticated", USER_A, finish(t1!, "success", 900));
    await age(USER_A, "next_eligible_at", 1);
    const [{ lease_token: t2 }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await commitAs(db, "authenticated", USER_A, finish(t2!, "rate_limited", 300));
    await age(USER_A, "next_eligible_at", 1);
    const [third] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(third.consecutive_failures, 1);
    await commitAs(db, "authenticated", USER_A, finish(third.lease_token!, "temporary_error", 600));
    const [row] = await as(db, "authenticated", USER_A, state);
    assert.deepEqual(row, { leased: false, last_result: "temporary_error", consecutive_failures: 2, succeeded: true, next_in: 600 });
  });

  it("a reconnection after the last run lifts the reconnect backoff at once", async () => {
    await commitAs(db, "authenticated", USER_A, `insert into public.google_calendar_connections (refresh_token_ciphertext) values ('${CIPHER}')`);
    const [{ lease_token }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    // The connection predates this failed run.
    await db.exec(`update public.google_calendar_connections set connected_at = now() - interval '2 minutes'`);
    await commitAs(db, "authenticated", USER_A, finish(lease_token!, "reconnect_required", 6 * 3600));
    assert.equal((await as<Claim>(db, "authenticated", USER_A, claim("automatic")))[0].reason, "not_due", "connected before the failed run: still waiting");

    // The user reconnects (the callback stores connected_at = now()).
    await commitAs(db, "authenticated", USER_A, `update public.google_calendar_connections set connected_at = now()`);
    const [due] = await as<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(due.claimed, true);
  });
});
