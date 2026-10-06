// Database-level guarantees of the manual Google Calendar sync (20261006122922):
// public.google_calendar_item_links (ownership, uniqueness, tombstones) and
// sync_google_calendar_events() (the only write path for Google-origin events).
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;

const CAL = "traza123@group.calendar.google.com";
const OTHER_CAL = "ana@example.com";
const CIPHER = "v1.k1.AAAAAAAAAAAAAAAA.cmVmcmVzaC1BLWNpcGhlcnRleHQtZmFrZQ";
const HASH = "a".repeat(64);
const GID = "0123456789abcdef0123456789abcdef";

const TASK_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const EVENT_A = "aaaaaaaa-0000-4000-8000-0000000000e1";
const TASK_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const EVENT_B = "bbbbbbbb-0000-4000-8000-0000000000e1";

const link = (values: { item_type?: string; task_id?: string | null; calendar_event_id?: string | null; google_event_id?: string; calendar?: string; hash?: string }) => {
  const v = { item_type: "task", task_id: TASK_A, calendar_event_id: null, google_event_id: GID, calendar: CAL, hash: HASH, ...values };
  const sql = (x: string | null) => (x === null ? "null" : `'${x}'`);
  return `insert into public.google_calendar_item_links (google_calendar_id, google_event_id, item_type, task_id, calendar_event_id, content_hash)
          values (${sql(v.calendar)}, ${sql(v.google_event_id)}, ${sql(v.item_type)}, ${sql(v.task_id)}, ${sql(v.calendar_event_id)}, ${sql(v.hash)})`;
};

const events = (items: Record<string, unknown>[]) => `'${JSON.stringify(items).replace(/'/g, "''")}'::jsonb`;
const gEvent = (id: string, values: Record<string, unknown> = {}) => ({
  event_id: id,
  title: "Clase de estructuras",
  description: null,
  location: "Aula 1",
  event_date: "2026-10-14",
  all_day: false,
  start_time: "09:00",
  end_time: "11:00",
  ...values,
});

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

before(async () => {
  db = await createDatabase();
  for (const [user, task, event] of [
    [USER_A, TASK_A, EVENT_A],
    [USER_B, TASK_B, EVENT_B],
  ]) {
    await commitAs(
      db,
      "authenticated",
      user,
      `insert into public.google_calendar_connections (google_account_email, refresh_token_ciphertext, selected_calendar_id, selected_calendar_name)
         values ('x@example.com', '${CIPHER}', '${CAL}', 'TRAZA');`,
    );
    // Fixture ids are chosen here for readability (as the table owner; clients never send ids).
    await db.exec(`
      insert into public.tasks (id, user_id, title, due_date) values ('${task}', '${user}', 'Panel final', '2026-10-20');
      insert into public.calendar_events (id, user_id, title, event_date, all_day) values ('${event}', '${user}', 'Revisión', '2026-10-12', true);
    `);
  }
});

describe("google_calendar_item_links: shape", () => {
  it("links a task or an event of the caller, with database-set owner and timestamps", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${link({})};
       ${link({ item_type: "calendar_event", task_id: null, calendar_event_id: EVENT_A, google_event_id: "fedcba9876543210" })};
       select user_id, item_type, task_id, calendar_event_id from public.google_calendar_item_links order by item_type`,
    );
    assert.deepEqual(rows, [
      { user_id: USER_A, item_type: "calendar_event", task_id: null, calendar_event_id: EVENT_A },
      { user_id: USER_A, item_type: "task", task_id: TASK_A, calendar_event_id: null },
    ]);
  });

  it("requires exactly the foreign key of its type", async () => {
    await rejects(as(db, "authenticated", USER_A, link({ task_id: null })), /needs its TRAZA item/);
    await rejects(as(db, "authenticated", USER_A, link({ calendar_event_id: EVENT_A })), /type_key/);
    await rejects(as(db, "authenticated", USER_A, link({ item_type: "calendar_event", task_id: TASK_A })), /needs its TRAZA item/);
    await rejects(as(db, "authenticated", USER_A, link({ item_type: "calendar_event", task_id: TASK_A, calendar_event_id: EVENT_A })), /type_key/);
    await rejects(as(db, "authenticated", USER_A, link({ item_type: "inbox" })), /type_valid|type_key/);  });

  it("checks Google event id and hash formats", async () => {
    for (const bad of ["ABC123", "xyz12", "abc", "has space", "a/b"]) await rejects(as(db, "authenticated", USER_A, link({ google_event_id: bad })), /event_id_format/);
    await rejects(as(db, "authenticated", USER_A, link({ hash: "nothex" })), /hash_format/);
    await rejects(as(db, "authenticated", USER_A, link({ calendar: "" })), /calendar_id_length/);
  });

  it("never mirrors a Google-origin event", async () => {
    await rejects(
      as(
        db,
        "authenticated",
        USER_A,
        `select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1")])});
         insert into public.google_calendar_item_links (google_calendar_id, google_event_id, item_type, calendar_event_id, content_hash)
           select '${CAL}', 'abcde12345', 'calendar_event', id, '${HASH}' from public.calendar_events where source = 'google-calendar'`,
      ),
      /not mirrored/,
    );
  });
});

describe("google_calendar_item_links: duplicates", () => {
  it("one mirror per item and calendar; one item per Google event and calendar", async () => {
    await rejects(as(db, "authenticated", USER_A, `${link({})}; ${link({ google_event_id: "fedcba9876543210" })}`), /task_key/);
    await rejects(
      as(db, "authenticated", USER_A, `${link({})}; ${link({ item_type: "calendar_event", task_id: null, calendar_event_id: EVENT_A })}`),
      /event_key/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `${link({ item_type: "calendar_event", task_id: null, calendar_event_id: EVENT_A })}; ${link({ item_type: "calendar_event", task_id: null, calendar_event_id: EVENT_A, google_event_id: "fedcba9876543210" })}`),
      /calendar_event_key/,
    );
  });

  it("allows the same item in another calendar (a previously selected one)", async () => {
    const rows = await as(db, "authenticated", USER_A, `${link({})}; ${link({ calendar: OTHER_CAL })}; select count(*)::int as n from public.google_calendar_item_links`);
    assert.deepEqual(rows, [{ n: 2 }]);
  });
});

describe("google_calendar_item_links: ownership", () => {
  it("cannot reference another user's task or event, even knowing its id", async () => {
    await rejects(as(db, "authenticated", USER_A, link({ task_id: TASK_B })), /task_owner_fkey|needs/);
    await rejects(as(db, "authenticated", USER_A, link({ item_type: "calendar_event", task_id: null, calendar_event_id: EVENT_B })), /event_owner_fkey|needs/);
  });

  it("shows, changes and deletes only the caller's own links", async () => {
    await commitAs(db, "authenticated", USER_B, link({ task_id: TASK_B }));
    try {
      assert.deepEqual(await as(db, "authenticated", USER_A, `select id from public.google_calendar_item_links`), []);
      const [{ n: updated }] = await as<{ n: number }>(
        db,
        "authenticated",
        USER_A,
        `with u as (update public.google_calendar_item_links set content_hash = '${"b".repeat(64)}' returning 1) select count(*)::int as n from u`,
      );
      const [{ n: deleted }] = await as<{ n: number }>(db, "authenticated", USER_A, `with d as (delete from public.google_calendar_item_links returning 1) select count(*)::int as n from d`);
      assert.deepEqual([updated, deleted], [0, 0]);
    } finally {
      await db.exec(`delete from public.google_calendar_item_links where user_id = '${USER_B}'`);
    }
  });

  it("does not let clients write the owner, id, item columns after insert, or timestamps", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.google_calendar_item_links (user_id, google_calendar_id, google_event_id, item_type, task_id, content_hash) values ('${USER_B}', '${CAL}', '${GID}', 'task', '${TASK_A}', '${HASH}')`),
      /permission denied/,
    );
    for (const column of [`user_id = '${USER_B}'`, `task_id = '${TASK_A}'`, `calendar_event_id = null`, `item_type = 'task'`, `google_calendar_id = 'x'`, `created_at = now()`, `id = gen_random_uuid()`]) {
      await rejects(as(db, "authenticated", USER_A, `${link({})}; update public.google_calendar_item_links set ${column}`), /permission denied/);
    }
    const [row] = await as(db, "authenticated", USER_A, `${link({})}; update public.google_calendar_item_links set google_event_id = 'fedcba9876543210', content_hash = '${"b".repeat(64)}' returning google_event_id`);
    assert.equal(row.google_event_id, "fedcba9876543210");
  });

  it("denies anon everything", async () => {
    await rejects(as(db, "anon", null, `select id from public.google_calendar_item_links`), /permission denied/);
    await rejects(as(db, "anon", null, link({})), /permission denied/);
    await rejects(as(db, "anon", null, `select * from public.sync_google_calendar_events('${CAL}', '[]'::jsonb)`), /permission denied/);
  });
});

describe("google_calendar_item_links: deletion tombstones", () => {
  it("deleting the task or event keeps the link with a null item (pending Google deletion)", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${link({})};
       ${link({ item_type: "calendar_event", task_id: null, calendar_event_id: EVENT_A, google_event_id: "fedcba9876543210" })};
       delete from public.tasks where id = '${TASK_A}';
       delete from public.calendar_events where id = '${EVENT_A}';
       select item_type, task_id, calendar_event_id, google_event_id from public.google_calendar_item_links order by item_type`,
    );
    assert.deepEqual(rows, [
      { item_type: "calendar_event", task_id: null, calendar_event_id: null, google_event_id: "fedcba9876543210" },
      { item_type: "task", task_id: null, calendar_event_id: null, google_event_id: GID },
    ]);
  });

  it("ignoring a Campus task (its delete path) also leaves a tombstone", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `select public.create_project_from_canvas_course('42', 'Taller');
       select * from public.sync_canvas_course_tasks('42', '[{"assignment_id":"7","title":"PRÁCTICA NÚMERO 3","due_date":"2026-10-22","submitted":false}]'::jsonb);
       insert into public.google_calendar_item_links (google_calendar_id, google_event_id, item_type, task_id, content_hash)
         select '${CAL}', '${GID}', 'task', id, '${HASH}' from public.tasks where source = 'canvas';
       select public.set_canvas_assignment_preference('42', '7', 'ignored');
       select count(*)::int as links, count(task_id)::int as with_item from public.google_calendar_item_links`,
    );
    assert.deepEqual(rows, [{ links: 1, with_item: 0 }]);
  });

  it("the owner can remove a link (after its Google event is deleted)", async () => {
    const rows = await as(db, "authenticated", USER_A, `${link({})}; delete from public.google_calendar_item_links; select count(*)::int as n from public.google_calendar_item_links`);
    assert.deepEqual(rows, [{ n: 0 }]);
  });
});

describe("sync_google_calendar_events", () => {
  it("creates Google-origin events with a built identity, then reports unchanged and updated", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1"), gEvent("indep2", { title: "Clase de estructuras", all_day: true, start_time: null, end_time: null })])});
       select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1"), gEvent("indep2", { title: "Tutoría", all_day: true, start_time: null, end_time: null })])});
       select source, external_id, title, start_time::text, project_id from public.calendar_events where source = 'google-calendar' order by external_id`,
    );
    assert.deepEqual(rows, [
      { source: "google-calendar", external_id: `calendar:${CAL}:event:indep1`, title: "Clase de estructuras", start_time: "09:00:00", project_id: null },
      { source: "google-calendar", external_id: `calendar:${CAL}:event:indep2`, title: "Tutoría", start_time: null, project_id: null },
    ]);
    const outcomes = await as(db, "authenticated", USER_A, `select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1")])})`);
    assert.deepEqual(outcomes, [{ event_id: "indep1", outcome: "created" }]);
    const second = await as(
      db,
      "authenticated",
      USER_A,
      `select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1")])});
       select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1"), gEvent("indep9")])})`,
    );
    assert.deepEqual(second, [
      { event_id: "indep1", outcome: "unchanged" },
      { event_id: "indep9", outcome: "created" },
    ]);
  });

  it("updates the same row and keeps the project the user chose in TRAZA", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1")])});
       insert into public.projects (name) values ('Estructuras');
       update public.calendar_events set project_id = (select id from public.projects where name = 'Estructuras') where source = 'google-calendar';
       create temp table before_ids on commit drop as select id from public.calendar_events where source = 'google-calendar';
       select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1", { title: "Cambiada", start_time: "10:00", end_time: null })])});
       select (select count(*)::int from public.calendar_events where source = 'google-calendar') as n,
              (select id from public.calendar_events where source = 'google-calendar') = (select id from before_ids) as same_row,
              (select project_id is not null from public.calendar_events where source = 'google-calendar') as kept_project,
              (select title from public.calendar_events where source = 'google-calendar') as title`,
    );
    assert.deepEqual(rows, [{ n: 1, same_row: true, kept_project: true, title: "Cambiada" }]);
  });

  it("never imports one of the caller's TRAZA mirrors", async () => {
    const rows = await as(db, "authenticated", USER_A, `${link({})}; select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent(GID)])})`);
    assert.deepEqual(rows, [{ event_id: GID, outcome: "mirror" }]);
  });

  it("only accepts the caller's selected calendar of a connected account", async () => {
    await rejects(as(db, "authenticated", USER_A, `select * from public.sync_google_calendar_events('${OTHER_CAL}', ${events([gEvent("x1")])})`), /not selected/);
    await rejects(
      as(
        db,
        "authenticated",
        USER_A,
        `update public.google_calendar_connections set status = 'revoked', refresh_token_ciphertext = null;
         select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("x1")])})`,
      ),
      /not selected/,
    );
  });

  it("cannot touch other users, manual events, tasks or other sources", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_B,
      `select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1", { title: "De B" })])});
       select user_id, title from public.calendar_events where source = 'google-calendar'`,
    );
    assert.deepEqual(rows, [{ user_id: USER_B, title: "De B" }]);
    const counts = await as(
      db,
      "authenticated",
      USER_A,
      `select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1")])});
       select (select count(*)::int from public.calendar_events where source = 'manual') as manual,
              (select title from public.calendar_events where id = '${EVENT_A}') as manual_title,
              (select count(*)::int from public.tasks) as tasks`,
    );
    assert.deepEqual(counts, [{ manual: 1, manual_title: "Revisión", tasks: 1 }]);
    // B's own import is untouched by A's call.
    const [bRow] = await as(db, "authenticated", USER_B, `select count(*)::int as n from public.calendar_events where source = 'google-calendar'`);
    assert.equal(bRow.n, 0);
  });

  it("rejects a malformed payload as a whole (nothing written)", async () => {
    for (const bad of [
      [gEvent("ok1"), gEvent("bad id")],
      [gEvent("ok1"), gEvent("ok2", { event_date: "2026-02-30" })],
      [gEvent("ok1"), gEvent("ok2", { start_time: "9:00" })],
      [gEvent("ok1"), gEvent("ok2", { all_day: "yes" })],
      [gEvent("ok1"), gEvent("ok2", { title: 7 })],
      [gEvent("ok1"), gEvent("ok2", { title: "   " })],
      [gEvent("ok1"), gEvent("ok2", { all_day: true })],
      [gEvent("ok1"), gEvent("ok2", { start_time: "10:00", end_time: "09:00" })],
    ]) {
      await rejects(
        as(db, "authenticated", USER_A, `select * from public.sync_google_calendar_events('${CAL}', ${events(bad)})`),
        /Invalid|check constraint|violates|out of range/,
      );
    }
    const [row] = await as(db, "authenticated", USER_A, `select count(*)::int as n from public.calendar_events where source = 'google-calendar'`);
    assert.equal(row.n, 0);
    await rejects(as(db, "authenticated", USER_A, `select * from public.sync_google_calendar_events('${CAL}', '{}'::jsonb)`), /Invalid events payload/);
  });

  it("requires a user, takes no user id, and is SECURITY DEFINER with an empty search_path", async () => {
    await rejects(as(db, "authenticated", null, `select * from public.sync_google_calendar_events('${CAL}', '[]'::jsonb)`), /Not authenticated/);
    await rejects(as(db, "authenticated", USER_A, `select * from public.sync_google_calendar_events('${USER_B}', '${CAL}', '[]'::jsonb)`), /does not exist/);
    const [fn] = await db
      .query<{ prosecdef: boolean; proconfig: string[]; anon: boolean; auth: boolean }>(
        `select prosecdef, proconfig, has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as auth
           from pg_proc where proname = 'sync_google_calendar_events'`,
      )
      .then((r) => r.rows);
    assert.deepEqual(fn, { prosecdef: true, proconfig: ['search_path=""'], anon: false, auth: true });
  });

  it("leaves calendar_events.source/external_id unwritable for clients", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.calendar_events (title, event_date, all_day, source, external_id) values ('x', '2026-10-12', true, 'google-calendar', 'calendar:x:event:y')`),
      /permission denied/,
    );
    await rejects(as(db, "authenticated", USER_A, `update public.calendar_events set source = 'google-calendar'`), /permission denied/);
  });
});

describe("Google disconnect", () => {
  it("deleting the connection keeps links, events and tasks", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${link({})};
       select * from public.sync_google_calendar_events('${CAL}', ${events([gEvent("indep1")])});
       delete from public.google_calendar_connections;
       select (select count(*)::int from public.google_calendar_item_links) as links,
              (select count(*)::int from public.calendar_events) as events,
              (select count(*)::int from public.tasks) as tasks`,
    );
    assert.deepEqual(rows, [{ links: 1, events: 2, tasks: 1 }]);
  });
});
