// Database-level guarantees of the notification tables: owner-only RLS, anon denial, no direct
// writes except deleting one's own devices, subscription uniqueness per user and endpoint, preference
// validation, durable dedupe of deliveries and owner-safe event references.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;

const P256DH = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const AUTH = "tBHItJI5svbpez7KI4CCXg";
const ENDPOINT_1 = "https://fcm.googleapis.com/fcm/send/device-one-aaaaaaaaaaaaaaaa";
const ENDPOINT_2 = "https://web.push.apple.com/device-two-bbbbbbbbbbbbbbbbbbbb";

const save = (endpoint: string, p256dh = P256DH, auth = AUTH) => `select public.save_push_subscription('${endpoint}', '${p256dh}', '${auth}') as id`;
const prefs = (lead = 60, details = false) => `select public.save_notification_preferences(true, true, false, true, ${lead}, ${details})`;
const claim = (key: string, kind = "tomorrow_tasks", event = "null") =>
  `select public.claim_notification_delivery('${kind}', '${key}', now(), ${event === "null" ? "null" : `'${event}'`}) as id`;
const finish = (id: string, status: string, code: string | null = null) =>
  `select public.finish_notification_delivery('${id}', '${status}', ${code ? `'${code}'` : "null"}) as ok`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

beforeEach(async () => {
  db = await createDatabase();
});

describe("push_subscriptions", () => {
  it("has RLS, gives anon nothing, and needs a signed-in user", async () => {
    for (const table of ["push_subscriptions", "notification_preferences", "notification_deliveries"]) {
      const [{ rls }] = await as<{ rls: boolean }>(db, "authenticated", USER_A, `select relrowsecurity as rls from pg_class where oid = 'public.${table}'::regclass`);
      assert.equal(rls, true, table);
      await rejects(as(db, "anon", null, `select * from public.${table}`), /permission denied/);
    }
    await rejects(as(db, "anon", null, save(ENDPOINT_1)), /permission denied/);
    await rejects(as(db, "authenticated", null, save(ENDPOINT_1)), /Not authenticated/);
  });

  it("a user saves their own subscription; the same endpoint updates instead of duplicating", async () => {
    const [{ id }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, save(ENDPOINT_1));
    const newKey = P256DH.replace("BNc", "BXc");
    const [{ id: again }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, save(ENDPOINT_1, newKey));
    assert.equal(again, id);
    const rows = await as(db, "authenticated", USER_A, `select user_id, endpoint, p256dh from public.push_subscriptions`);
    assert.deepEqual(rows, [{ user_id: USER_A, endpoint: ENDPOINT_1, p256dh: newKey }]);
    await commitAs(db, "authenticated", USER_A, save(ENDPOINT_2));
    assert.equal((await as(db, "authenticated", USER_A, `select id from public.push_subscriptions`)).length, 2, "several devices per user");
  });

  it("rejects malformed and oversized values", async () => {
    for (const [endpoint, p256dh, auth] of [
      ["http://insecure.example.com/push/aaaaaaaaaaaa", P256DH, AUTH],
      ["https://x", P256DH, AUTH],
      [`https://push.example.com/${"a".repeat(2100)}`, P256DH, AUTH],
      ["https://push.example.com/has space/aaaaaaaaaa", P256DH, AUTH],
      [ENDPOINT_1, "short", AUTH],
      [ENDPOINT_1, P256DH, "not base64 !"],
      [ENDPOINT_1, P256DH, "a".repeat(80)],
    ]) {
      await rejects(as(db, "authenticated", USER_A, save(endpoint, p256dh, auth)), /push_subscriptions_/);
    }
  });

  it("isolates users: B cannot see, delete or overwrite A's subscription", async () => {
    await commitAs(db, "authenticated", USER_A, save(ENDPOINT_1));
    assert.deepEqual(await as(db, "authenticated", USER_B, `select id from public.push_subscriptions`), []);
    const deleted = await as(db, "authenticated", USER_B, `delete from public.push_subscriptions returning id`);
    assert.deepEqual(deleted, []);
    // B subscribing the same endpoint creates B's own row; A's row is untouched.
    await commitAs(db, "authenticated", USER_B, save(ENDPOINT_1, P256DH.replace("BNc", "BBc")));
    const [a] = await as<{ p256dh: string }>(db, "authenticated", USER_A, `select p256dh from public.push_subscriptions`);
    assert.equal(a.p256dh, P256DH);
  });

  it("allows deleting one's own device only; never direct inserts or updates", async () => {
    await commitAs(db, "authenticated", USER_A, `${save(ENDPOINT_1)}; ${save(ENDPOINT_2)}`);
    await rejects(as(db, "authenticated", USER_A, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ('${ENDPOINT_1}x', '${P256DH}', '${AUTH}')`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `update public.push_subscriptions set auth = '${AUTH}'`), /permission denied/);
    const rows = await as<{ endpoint: string }>(db, "authenticated", USER_A, `delete from public.push_subscriptions where endpoint = '${ENDPOINT_1}'; select endpoint from public.push_subscriptions`);
    assert.deepEqual(rows, [{ endpoint: ENDPOINT_2 }], "unsubscribing one device leaves the other");
  });
});

describe("notification_preferences", () => {
  it("has safe defaults and is saved only through the function", async () => {
    await commitAs(db, "authenticated", USER_A, `insert into public.notification_preferences default values`).catch(() => undefined);
    assert.deepEqual(await as(db, "authenticated", USER_A, `select * from public.notification_preferences`), [], "no direct insert");
    await commitAs(db, "authenticated", USER_A, prefs());
    const [row] = await as(db, "authenticated", USER_A, `select push_enabled, tomorrow_tasks, morning_summary, event_reminders, event_lead_minutes, show_details from public.notification_preferences`);
    assert.deepEqual(row, { push_enabled: true, tomorrow_tasks: true, morning_summary: false, event_reminders: true, event_lead_minutes: 60, show_details: false });
    await commitAs(db, "authenticated", USER_A, prefs(15, true));
    const [updated] = await as<{ event_lead_minutes: number; show_details: boolean }>(db, "authenticated", USER_A, `select event_lead_minutes, show_details from public.notification_preferences`);
    assert.deepEqual(updated, { event_lead_minutes: 15, show_details: true });
    await rejects(as(db, "authenticated", USER_A, `update public.notification_preferences set show_details = false`), /permission denied/);
  });

  it("rejects invalid lead times and nulls; owner-only", async () => {
    for (const lead of [0, 5, 45, 1440]) await rejects(as(db, "authenticated", USER_A, prefs(lead)), /notification_preferences_lead_valid/);
    await rejects(as(db, "authenticated", USER_A, `select public.save_notification_preferences(null, true, true, true, 60, false)`), /Invalid preferences/);
    await commitAs(db, "authenticated", USER_A, prefs());
    assert.deepEqual(await as(db, "authenticated", USER_B, `select user_id from public.notification_preferences`), []);
  });
});

describe("notification_deliveries", () => {
  it("dedupes durably: the same key is claimed once; a different day's key is a new reminder", async () => {
    const [{ id }] = await commitAs<{ id: string | null }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    assert.ok(id);
    for (let i = 0; i < 3; i++) {
      const [again] = await commitAs<{ id: string | null }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
      assert.equal(again.id, null, "being sent: never twice");
    }
    await commitAs(db, "authenticated", USER_A, finish(id!, "sent"));
    const [afterSent] = await commitAs<{ id: string | null }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    assert.equal(afterSent.id, null, "sent: never again");
    const [next] = await commitAs<{ id: string | null }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-10"));
    assert.ok(next.id);
    const rows = await as<{ dedupe_key: string; status: string; sent: boolean }>(db, "authenticated", USER_A, `select dedupe_key, status, sent_at is not null as sent from public.notification_deliveries order by dedupe_key`);
    assert.deepEqual(rows, [
      { dedupe_key: "tomorrow_tasks:2026-10-09", status: "sent", sent: true },
      { dedupe_key: "tomorrow_tasks:2026-10-10", status: "pending", sent: false },
    ]);
  });

  it("a temporary failure may be retried (bounded); a permanent one or a skip is final; retries never add rows", async () => {
    const [{ id }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("morning_summary:2026-10-09", "morning_summary"));
    await commitAs(db, "authenticated", USER_A, finish(id, "failed", "temporary_error"));
    const [retry] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("morning_summary:2026-10-09", "morning_summary"));
    assert.equal(retry.id, id, "same row, not a duplicate");
    await commitAs(db, "authenticated", USER_A, finish(id, "failed", "temporary_error"));
    const [third] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("morning_summary:2026-10-09", "morning_summary"));
    assert.equal(third.id, id);
    await commitAs(db, "authenticated", USER_A, finish(id, "failed", "temporary_error"));
    const [exhausted] = await commitAs<{ id: string | null }>(db, "authenticated", USER_A, claim("morning_summary:2026-10-09", "morning_summary"));
    assert.equal(exhausted.id, null, "at most 3 attempts");

    const [{ id: other }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    await commitAs(db, "authenticated", USER_A, finish(other, "skipped", "no_subscriptions"));
    assert.equal((await commitAs<{ id: string | null }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09")))[0].id, null);
    const [{ n }] = await as<{ n: number }>(db, "authenticated", USER_A, `select count(*)::int as n from public.notification_deliveries`);
    assert.equal(n, 2);
  });

  it("a crashed sender's pending claim can be retaken after 10 minutes", async () => {
    const [{ id }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    const [early] = await commitAs<{ id: string | null }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    assert.equal(early.id, null, "a fresh pending claim is not retaken");
    // Simulate 11 minutes passing (the updated_at trigger is paused so the past value sticks).
    await db.exec(`alter table public.notification_deliveries disable trigger notification_deliveries_set_updated_at`);
    await db.exec(`update public.notification_deliveries set updated_at = now() - interval '11 minutes' where id = '${id}'`);
    await db.exec(`alter table public.notification_deliveries enable trigger notification_deliveries_set_updated_at`);
    const [retaken] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    assert.equal(retaken.id, id);
  });

  it("validates kinds, keys, statuses and codes; no direct writes", async () => {
    await rejects(as(db, "authenticated", USER_A, claim("x:1", "marketing")), /notification_deliveries_kind_valid/);
    await rejects(as(db, "authenticated", USER_A, claim("Tareas para mañana: Panel")), /notification_deliveries_key_format/);
    const [{ id }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    await rejects(as(db, "authenticated", USER_A, finish(id, "pending")), /Invalid status/);
    await rejects(as(db, "authenticated", USER_A, finish(id, "failed", "HTTP 410 Gone from fcm.googleapis.com")), /notification_deliveries_failure_valid/);
    await rejects(as(db, "authenticated", USER_A, `insert into public.notification_deliveries (kind, dedupe_key, scheduled_for) values ('tomorrow_tasks', 'tomorrow_tasks:x', now())`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `update public.notification_deliveries set status = 'sent'`), /permission denied/);
  });

  it("isolates users: B cannot read or finish A's deliveries, and has its own dedupe space", async () => {
    const [{ id }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim("tomorrow_tasks:2026-10-09"));
    assert.deepEqual(await as(db, "authenticated", USER_B, `select id from public.notification_deliveries`), []);
    const [{ ok }] = await as<{ ok: boolean }>(db, "authenticated", USER_B, finish(id, "sent"));
    assert.equal(ok, false);
    const [b] = await as<{ id: string | null }>(db, "authenticated", USER_B, claim("tomorrow_tasks:2026-10-09"));
    assert.ok(b.id, "the same key for another user is independent");
  });

  it("an event reminder can only reference the caller's own event (composite key), and survives its deletion", async () => {
    const [{ id: eventA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.calendar_events (title, event_date, start_time, all_day) values ('Crítica', '2026-10-09', '10:00', false) returning id`);
    await rejects(as(db, "authenticated", USER_B, claim(`event:${eventA}:60m:2026-10-09T09.00Z`, "event_reminder", eventA)), /notification_deliveries_event_owner_fkey/);
    await rejects(as(db, "authenticated", USER_A, claim(`tomorrow_tasks:x`, "tomorrow_tasks", eventA)), /notification_deliveries_event_kind/);
    const [{ id }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, claim(`event:${eventA}:60m:2026-10-09T09.00Z`, "event_reminder", eventA));
    await commitAs(db, "authenticated", USER_A, `delete from public.calendar_events where id = '${eventA}'`);
    const [row] = await as<{ id: string; event_id: string | null }>(db, "authenticated", USER_A, `select id, event_id from public.notification_deliveries`);
    assert.deepEqual(row, { id, event_id: null });
  });
});
