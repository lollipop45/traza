// The scheduler_* database functions (migration *_scheduler_rpcs.sql): the trusted scheduler's
// variants of the functions the background engines use, for an explicit p_user_id instead of
// auth.uid(). Guarantees checked here:
//   - each body is the interactive original VERBATIM except where the user comes from (parity);
//   - only service_role may execute them (never anon / authenticated, whatever p_user_id they send);
//   - p_user_id is validated (unknown / null user → rejected like a missing session);
//   - user A's scheduled call never reads or changes user B's rows;
//   - leases and delivery dedupe are SHARED with the interactive functions (same rows).
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { as, commitAs, createDatabase, USER_A, USER_B } from "./harness";

const FUNCTIONS = [
  "claim_canvas_sync",
  "finish_canvas_sync",
  "sync_canvas_course_tasks",
  "get_google_calendar_credentials",
  "claim_google_calendar_sync",
  "finish_google_calendar_sync",
  "sync_google_calendar_events",
  "claim_notification_delivery",
  "finish_notification_delivery",
];
const UNKNOWN_USER = "00000000-0000-4000-8000-0000000000ff";
const cipher = (tag: string) => `v1.k1.AAAAAAAAAAAAAAAA.${tag.padEnd(24, "0")}`;

let db: PGlite;

/** As the Data API's service_role (the secret key), in a rolled-back transaction. */
async function asService<T = Record<string, unknown>>(sql: string, commit = false): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role; select set_config('request.jwt.claim.sub', '', true);");
    const results = await tx.exec(sql);
    if (!commit) await tx.rollback();
    return (results.at(-1)?.rows ?? []) as T[];
  });
}

/** As the database owner (fixtures that clients cannot write directly). */
async function asOwner<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const results = await db.exec(sql);
  return (results.at(-1)?.rows ?? []) as T[];
}

let projectA: string;
let projectB: string;
let eventB: string;

before(async () => {
  db = await createDatabase();
  [{ id: projectA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Taller A') returning id`);
  [{ id: projectB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `insert into public.projects (name) values ('Taller B') returning id`);
  await commitAs(db, "authenticated", USER_A, `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('111', '${projectA}', 'linked')`);
  await commitAs(db, "authenticated", USER_B, `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('222', '${projectB}', 'linked')`);
  [{ id: eventB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `insert into public.calendar_events (title, event_date, all_day) values ('Evento de B', '2026-10-09', true) returning id`);
  await asOwner(`
    insert into public.google_calendar_connections (user_id, status, refresh_token_ciphertext, selected_calendar_id, selected_calendar_name)
    values ('${USER_A}', 'connected', '${cipher("REFRESHA")}', 'cal-a', 'A'), ('${USER_B}', 'connected', '${cipher("REFRESHB")}', 'cal-b', 'B');
  `);
});

describe("scheduler RPCs: identical logic to the interactive functions", () => {
  it("each body is the original verbatim except that the user comes from p_user_id (validated)", async () => {
    for (const name of FUNCTIONS) {
      const rows = await asOwner<{ proname: string; prosrc: string; result: string; args: string; definer: boolean; config: string[] | null }>(`
        select p.proname, p.prosrc, pg_get_function_result(p.oid) as result, pg_get_function_arguments(p.oid) as args,
               p.prosecdef as definer, p.proconfig as config
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('${name}', 'scheduler_${name}')`);
      const original = rows.find((row) => row.proname === name)!;
      const scheduled = rows.find((row) => row.proname === `scheduler_${name}`)!;
      assert.ok(original && scheduled, name);
      assert.ok(scheduled.prosrc.includes("traza_private.scheduler_target(p_user_id)"), name);
      assert.ok(!scheduled.prosrc.includes("auth.uid()"), `${name}: no auth.uid() left`);
      assert.equal(scheduled.prosrc.split("traza_private.scheduler_target(p_user_id)").join("(select auth.uid())"), original.prosrc, `${name}: body drifted`);
      assert.equal(scheduled.result, original.result, name);
      assert.equal(scheduled.args, original.args ? `p_user_id uuid, ${original.args}` : "p_user_id uuid", name);
      assert.equal(scheduled.definer, original.definer, name);
      assert.deepEqual(scheduled.config, ['search_path=""'], name);
    }
  });

  it("the interactive functions are unchanged and still callable by signed-in users", async () => {
    for (const name of FUNCTIONS) {
      const [{ ok }] = await asOwner<{ ok: boolean }>(`select has_function_privilege('authenticated', 'public.${name}'::regproc, 'execute') as ok`);
      assert.equal(ok, true, name);
    }
  });
});

describe("scheduler RPCs: only the trusted backend role may call them", () => {
  it("anon and authenticated cannot execute any of them (whatever p_user_id they would send); service_role can", async () => {
    for (const name of FUNCTIONS) {
      const [privileges] = await asOwner<{ anon: boolean; authenticated: boolean; service: boolean; public_: boolean }>(`
        select has_function_privilege('anon', 'public.scheduler_${name}'::regproc, 'execute') as anon,
               has_function_privilege('authenticated', 'public.scheduler_${name}'::regproc, 'execute') as authenticated,
               has_function_privilege('service_role', 'public.scheduler_${name}'::regproc, 'execute') as service,
               exists (select 1 from information_schema.routine_privileges
                        where routine_name = 'scheduler_${name}' and grantee = 'PUBLIC') as public_`);
      assert.deepEqual(privileges, { anon: false, authenticated: false, service: true, public_: false }, name);
    }
    await assert.rejects(as(db, "authenticated", USER_A, `select * from public.scheduler_claim_canvas_sync('${USER_B}', 'automatic', 300)`), /permission denied/);
    await assert.rejects(as(db, "anon", null, `select * from public.scheduler_get_google_calendar_credentials('${USER_A}')`), /permission denied/);
    await assert.rejects(as(db, "authenticated", USER_A, `select traza_private.scheduler_target('${USER_B}')`), /permission denied/);
  });

  it("an unknown or missing p_user_id is rejected exactly like a missing session", async () => {
    for (const user of [UNKNOWN_USER, null]) {
      const id = user ? `'${user}'` : "null";
      await assert.rejects(asService(`select * from public.scheduler_claim_canvas_sync(${id}, 'automatic', 300)`), /Not authenticated/);
      await assert.rejects(asService(`select * from public.scheduler_get_google_calendar_credentials(${id})`), /Not authenticated/);
      await assert.rejects(asService(`select public.scheduler_claim_notification_delivery(${id}, 'tomorrow_tasks', 'tomorrow_tasks:2026-10-09', now())`), /Not authenticated/);
    }
  });
});

describe("scheduler RPCs: user A's scheduled call never touches user B", () => {
  it("credentials: only the target user's ciphertext", async () => {
    const rows = await asService<{ refresh_token_ciphertext: string }>(`select refresh_token_ciphertext from public.scheduler_get_google_calendar_credentials('${USER_A}')`);
    assert.deepEqual(rows.map((row) => row.refresh_token_ciphertext), [cipher("REFRESHA")]);
  });

  it("Canvas tasks: only into a course the TARGET user linked, owned by the target user", async () => {
    const assignment = `'[{"assignment_id":"9","title":"Entrega","due_date":"2026-10-20","submitted":false}]'::jsonb`;
    await assert.rejects(asService(`select * from public.scheduler_sync_canvas_course_tasks('${USER_A}', '222', ${assignment})`), /not linked/);
    const rows = await asService<{ user_id: string; project_id: string }>(`
      select * from public.scheduler_sync_canvas_course_tasks('${USER_A}', '111', ${assignment});
      select user_id, project_id from public.tasks where source = 'canvas';`);
    assert.deepEqual(rows, [{ user_id: USER_A, project_id: projectA }]);
  });

  it("reminders: an event of another user cannot be referenced; another user's delivery cannot be finished", async () => {
    await assert.rejects(
      asService(`select public.scheduler_claim_notification_delivery('${USER_A}', 'event_reminder', 'event:${eventB}:60m:2026-10-09T09:00:00.000Z', now(), '${eventB}')`),
      /notification_deliveries_event_owner_fkey/,
    );
    const [{ id: deliveryB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `select public.claim_notification_delivery('tomorrow_tasks', 'tomorrow_tasks:2026-10-07', now()) as id`);
    const [{ ok }] = await asService<{ ok: boolean }>(`select public.scheduler_finish_notification_delivery('${USER_A}', '${deliveryB}', 'sent') as ok`);
    assert.equal(ok, false);
    const [{ status }] = await asOwner<{ status: string }>(`select status from public.notification_deliveries where id = '${deliveryB}'`);
    assert.equal(status, "pending", "B's delivery untouched");
  });
});

describe("scheduler RPCs: shared leases and dedupe with the interactive path (idempotency)", () => {
  it("a reminder claimed interactively is not claimed again by the scheduler (and vice versa); other users are independent", async () => {
    const key = "tomorrow_tasks:2026-10-10";
    const [{ id: first }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `select public.claim_notification_delivery('tomorrow_tasks', '${key}', now()) as id`);
    assert.ok(first);
    const [{ id: again }] = await asService<{ id: string | null }>(`select public.scheduler_claim_notification_delivery('${USER_A}', 'tomorrow_tasks', '${key}', now()) as id`);
    assert.equal(again, null, "scheduler sees the interactive claim");
    const [{ id: forB }] = await asService<{ id: string | null }>(`select public.scheduler_claim_notification_delivery('${USER_B}', 'tomorrow_tasks', '${key}', now()) as id`);
    assert.ok(forB, "another user's reminder is independent");

    const key2 = "tomorrow_tasks:2026-10-11";
    await asService(`select public.scheduler_claim_notification_delivery('${USER_A}', 'tomorrow_tasks', '${key2}', now())`, true);
    const [{ id: interactive }] = await as<{ id: string | null }>(db, "authenticated", USER_A, `select public.claim_notification_delivery('tomorrow_tasks', '${key2}', now()) as id`);
    assert.equal(interactive, null, "the interactive check sees the scheduler's claim");
  });

  it("Canvas and Google leases: a scheduled claim blocks the browser / manual claim for that user only", async () => {
    for (const fn of ["claim_canvas_sync", "claim_google_calendar_sync"]) {
      const [held] = await asService<{ claimed: boolean }>(`select * from public.scheduler_${fn}('${USER_A}', 'automatic', 300)`, true);
      assert.equal(held.claimed, true, fn);
      const [browser] = await as<{ claimed: boolean; reason: string }>(db, "authenticated", USER_A, `select * from public.${fn}('manual', 300)`);
      assert.deepEqual([browser.claimed, browser.reason], [false, "already_running"], fn);
      const [secondScheduler] = await asService<{ claimed: boolean; reason: string }>(`select * from public.scheduler_${fn}('${USER_A}', 'automatic', 300)`);
      assert.deepEqual([secondScheduler.claimed, secondScheduler.reason], [false, "already_running"], `${fn}: two scheduler runs never overlap`);
      const [otherUser] = await as<{ claimed: boolean }>(db, "authenticated", USER_B, `select * from public.${fn}('manual', 300)`);
      assert.equal(otherUser.claimed, true, `${fn}: user B is independent`);
    }
  });

  it("this migration adds no policy, changes no table and grants nothing to client roles", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "supabase", "migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_scheduler_rpcs.sql"));
    assert.ok(file);
    const sql = readFileSync(join(dir, file!), "utf8").replace(/--.*$/gm, "");
    assert.doesNotMatch(sql, /\b(create|alter|drop) (table|policy)\b|row level security|grant [^;]* to (anon|authenticated|public)\b/i);
    assert.doesNotMatch(sql, /create or replace function public\.(?!scheduler_)/i, "no interactive function is redefined");
    assert.doesNotMatch(sql, /sb_secret_|vercel\.app|Bearer /);
  });
});
