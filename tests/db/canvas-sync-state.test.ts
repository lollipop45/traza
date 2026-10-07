// Database-level guarantees of public.canvas_sync_state and its two functions: owner-only reads, no
// direct writes, an atomic per-user lease, cooldown / backoff bookkeeping and cross-user isolation.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;

type Claim = { claimed: boolean; reason: string; lease_token: string | null; consecutive_failures: number };

const claim = (trigger: "automatic" | "manual", lease = 300) => `select * from public.claim_canvas_sync('${trigger}', ${lease})`;
const finish = (token: string, result: string, error: string | null, seconds: number, counts = "") =>
  `select public.finish_canvas_sync('${token}', '${result}', ${seconds}, ${error ? `'${error}'` : "null"}${counts}) as ok`;
const state = `select lease_until is not null as leased, last_result, last_error_code, consecutive_failures,
                      last_success_at is not null as succeeded, last_trigger,
                      round(extract(epoch from (next_eligible_at - now())))::int as next_in
                 from public.canvas_sync_state`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

/** Moves the user's clock-dependent columns into the past (as the table owner), simulating elapsed time. */
const age = (userId: string, column: "lease_until" | "next_eligible_at", seconds: number) =>
  db.exec(`update public.canvas_sync_state set ${column} = now() - interval '${seconds} seconds' where user_id = '${userId}'`);

beforeEach(async () => {
  db = await createDatabase();
});

describe("canvas_sync_state: access", () => {
  it("has RLS enabled and gives anon nothing", async () => {
    const [{ rls }] = await as<{ rls: boolean }>(db, "authenticated", USER_A, `select relrowsecurity as rls from pg_class where oid = 'public.canvas_sync_state'::regclass`);
    assert.equal(rls, true);
    await rejects(as(db, "anon", null, `select * from public.canvas_sync_state`), /permission denied/);
    await rejects(as(db, "anon", null, claim("automatic")), /permission denied/);
    await rejects(as(db, "anon", null, finish("00000000-0000-4000-8000-000000000000", "success", null, 1800)), /permission denied/);
  });

  it("rejects an authenticated role without a user id", async () => {
    await rejects(as(db, "authenticated", null, claim("automatic")), /Not authenticated/);
  });

  it("is read-only for clients: no insert, update or delete, and the lease token is not readable", async () => {
    await commitAs(db, "authenticated", USER_A, claim("automatic"));
    await rejects(as(db, "authenticated", USER_A, `insert into public.canvas_sync_state (user_id) values ('${USER_A}')`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `update public.canvas_sync_state set next_eligible_at = null`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `update public.canvas_sync_state set lease_until = null`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `delete from public.canvas_sync_state`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `select lease_token from public.canvas_sync_state`), /permission denied/);
    const rows = await as(db, "authenticated", USER_A, `select user_id, lease_until is not null as leased from public.canvas_sync_state`);
    assert.deepEqual(rows, [{ user_id: USER_A, leased: true }]);
  });

  it("isolates users: B sees nothing of A, and has its own independent lease", async () => {
    const [a] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(a.claimed, true);
    assert.deepEqual(await as(db, "authenticated", USER_B, `select * from public.canvas_sync_state`.replace("*", "user_id")), []);
    // A's lease does not block B.
    const [b] = await as<Claim>(db, "authenticated", USER_B, claim("automatic"));
    assert.equal(b.claimed, true);
    // B cannot finish (release) A's lease, even with A's token.
    const [{ ok }] = await as<{ ok: boolean }>(db, "authenticated", USER_B, finish(a.lease_token!, "success", null, 1800));
    assert.equal(ok, false);
    const [{ leased }] = await as<{ leased: boolean }>(db, "authenticated", USER_A, state);
    assert.equal(leased, true);
  });

  it("validates its arguments", async () => {
    await rejects(as(db, "authenticated", USER_A, `select * from public.claim_canvas_sync('cron', 300)`), /Invalid trigger/);
    await rejects(as(db, "authenticated", USER_A, claim("automatic", 5)), /Invalid lease/);
    await rejects(as(db, "authenticated", USER_A, claim("automatic", 3600)), /Invalid lease/);
    const [{ lease_token }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await rejects(as(db, "authenticated", USER_A, finish(lease_token!, "done", null, 1800)), /Invalid result/);
    await rejects(as(db, "authenticated", USER_A, finish(lease_token!, "success", null, 10)), /Invalid next eligible/);
    await rejects(as(db, "authenticated", USER_A, finish(lease_token!, "temporary_error", "Canvas said: token abc", 300)), /canvas_sync_state_error_valid/);
    await rejects(as(db, "authenticated", USER_A, finish(lease_token!, "success", null, 1800, ", -1")), /canvas_sync_state_counts_range/);
  });
});

describe("canvas_sync_state: lease", () => {
  it("first automatic sync is due, and the claim takes the lease", async () => {
    const [first] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(first.claimed, true);
    assert.equal(first.reason, "claimed");
    assert.match(first.lease_token ?? "", /^[0-9a-f-]{36}$/);
    const [row] = await as<{ leased: boolean; last_trigger: string }>(db, "authenticated", USER_A, state);
    assert.equal(row.leased, true);
    assert.equal(row.last_trigger, "automatic");
  });

  it("tab A claims, tab B is refused while A runs (automatic or manual), then B can run after A finishes", async () => {
    const [a] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    const [b] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.deepEqual([b.claimed, b.reason, b.lease_token], [false, "already_running", null]);
    const [manual] = await commitAs<Claim>(db, "authenticated", USER_A, claim("manual"));
    assert.deepEqual([manual.claimed, manual.reason], [false, "already_running"]);

    const [{ ok }] = await commitAs<{ ok: boolean }>(db, "authenticated", USER_A, finish(a.lease_token!, "success", null, 1800, ", 3, 2, 4, 5, 1, 7, 1"));
    assert.equal(ok, true);
    const [row] = await as<Record<string, unknown>>(db, "authenticated", USER_A, `select lease_until, last_courses_count, last_imported_count, last_updated_count, last_unchanged_count, last_ignored_count, last_skipped_count, last_review_count from public.canvas_sync_state`);
    assert.deepEqual(row, { lease_until: null, last_courses_count: 3, last_imported_count: 2, last_updated_count: 4, last_unchanged_count: 5, last_ignored_count: 1, last_skipped_count: 7, last_review_count: 1 });

    // A finished successfully: automatic is now inside the cooldown, manual may run.
    const [auto] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.deepEqual([auto.claimed, auto.reason], [false, "not_due"]);
    const [again] = await commitAs<Claim>(db, "authenticated", USER_A, claim("manual"));
    assert.equal(again.claimed, true);
  });

  it("a stale (expired) lease can be reclaimed, and the crashed holder can no longer finish", async () => {
    const [crashed] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await age(USER_A, "lease_until", 1);
    const [next] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(next.claimed, true);
    assert.notEqual(next.lease_token, crashed.lease_token);
    const [{ ok }] = await as<{ ok: boolean }>(db, "authenticated", USER_A, finish(crashed.lease_token!, "success", null, 1800));
    assert.equal(ok, false, "the old token is no longer the lease");
  });

  it("concurrent claims: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"))));
    assert.equal(results.filter(([row]) => row.claimed).length, 1);
    assert.equal(results.filter(([row]) => row.reason === "already_running").length, 5);
  });
});

describe("canvas_sync_state: cooldown and backoff", () => {
  it("success sets the cooldown, resets failures and records the success time", async () => {
    const [{ lease_token }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await commitAs(db, "authenticated", USER_A, finish(lease_token!, "success", null, 1800));
    const [row] = await as<Record<string, unknown>>(db, "authenticated", USER_A, state);
    assert.deepEqual(row, { leased: false, last_result: "success", last_error_code: null, consecutive_failures: 0, succeeded: true, last_trigger: "automatic", next_in: 1800 });

    // Inside the cooldown: not_due. Once it has passed: due again.
    const [early] = await as<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(early.reason, "not_due");
    await age(USER_A, "next_eligible_at", 1);
    const [due] = await as<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(due.claimed, true);
  });

  it("failures count up, keep a safe code, keep the last success time, and use the given backoff", async () => {
    const [{ lease_token: t1 }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await commitAs(db, "authenticated", USER_A, finish(t1!, "success", null, 1800));
    await age(USER_A, "next_eligible_at", 1);

    const [{ lease_token: t2 }] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    await commitAs(db, "authenticated", USER_A, finish(t2!, "temporary_error", "canvas_5xx", 300));
    await age(USER_A, "next_eligible_at", 1);
    const [third] = await commitAs<Claim>(db, "authenticated", USER_A, claim("automatic"));
    assert.equal(third.consecutive_failures, 1, "the claimer learns the failure count to compute the next backoff");
    await commitAs(db, "authenticated", USER_A, finish(third.lease_token!, "auth_error", "canvas_401", 7200));

    const [row] = await as<Record<string, unknown>>(db, "authenticated", USER_A, state);
    assert.deepEqual(row, { leased: false, last_result: "auth_error", last_error_code: "canvas_401", consecutive_failures: 2, succeeded: true, last_trigger: "automatic", next_in: 7200 });

    // A manual success clears the failure state.
    const [manual] = await commitAs<Claim>(db, "authenticated", USER_A, claim("manual"));
    await commitAs(db, "authenticated", USER_A, finish(manual.lease_token!, "success", "canvas_401", 1800));
    const [clean] = await as<Record<string, unknown>>(db, "authenticated", USER_A, state);
    assert.equal(clean.consecutive_failures, 0);
    assert.equal(clean.last_error_code, null, "no error code is kept on success");
  });
});

describe("mappings are not trusted once their project is gone", () => {
  it("deleting the project removes the link, and sync_canvas_course_tasks then refuses the course", async () => {
    const [{ id }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Taller') returning id`);
    await commitAs(db, "authenticated", USER_A, `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('145580', '${id}', 'linked')`);
    const write = `select * from public.sync_canvas_course_tasks('145580', '[{"assignment_id":"7001","title":"Panel","due_date":"2026-10-12","submitted":false}]'::jsonb)`;
    const [ok] = await as<{ outcome: string }>(db, "authenticated", USER_A, write);
    assert.equal(ok.outcome, "created");

    await commitAs(db, "authenticated", USER_A, `delete from public.projects where id = '${id}'`);
    const links = await as(db, "authenticated", USER_A, `select * from public.canvas_course_links`);
    assert.deepEqual(links, []);
    await rejects(as(db, "authenticated", USER_A, write), /not linked/);
  });
});
