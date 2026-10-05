// Database-level guarantees for calendar events: constraints, RLS, privileges, the ownership-safe
// project link and import de-duplication. Tested in SQL, independent of the app.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;
let projectA: string;
let projectB: string;
let eventA: string;

before(async () => {
  db = await createDatabase();
  [{ id: projectA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Taller de Proyectos') returning id`);
  [{ id: projectB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `insert into public.projects (name) values ('Proyecto de B') returning id`);
  [{ id: eventA }] = await commitAs<{ id: string }>(
    db,
    "authenticated",
    USER_A,
    `insert into public.calendar_events (title, event_date, start_time, end_time, location, project_id)
     values ('Tutoría', '2026-10-07', '11:00', '11:30', 'Despacho 2.14', '${projectA}') returning id`,
  );
});

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

const insertEvent = (columns: string, values: string) =>
  `insert into public.calendar_events (${columns}) values (${values}) returning *`;

describe("calendar_events: schema", () => {
  it("fills owner, source, all_day and timestamps from defaults; keeps local date and time as entered", async () => {
    const [row] = await as(db, "authenticated", USER_A, `select * from public.calendar_events where id = '${eventA}'`);
    assert.equal(row.user_id, USER_A);
    assert.equal(row.source, "manual");
    assert.equal(row.all_day, false);
    assert.equal(row.start_time, "11:00:00");
    assert.equal(row.end_time, "11:30:00");
    const [day] = await as<{ d: string }>(db, "authenticated", USER_A, `select event_date::text as d from public.calendar_events where id = '${eventA}'`);
    assert.equal(day.d, "2026-10-07");
  });

  it("does not shift dates or times with the session time zone", async () => {
    const [row] = await as<{ d: string; t: string }>(
      db,
      "authenticated",
      USER_A,
      `set local time zone 'Pacific/Kiritimati';
       select event_date::text as d, start_time::text as t from public.calendar_events where id = '${eventA}'`,
    );
    assert.deepEqual(row, { d: "2026-10-07", t: "11:00:00" });
  });

  it("accepts all-day events without times", async () => {
    const [row] = await as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day", `'Jornadas', '2026-10-09', true`));
    assert.equal(row.start_time, null);
  });

  it("rejects inconsistent times", async () => {
    const cases = [
      ["all-day with a start time", `'x', '2026-10-09', true, '10:00', null`],
      ["timed without a start time", `'x', '2026-10-09', false, null, null`],
      ["end without start", `'x', '2026-10-09', false, null, '10:00'`],
      ["end before start", `'x', '2026-10-09', false, '12:00', '11:00'`],
    ];
    for (const [name, values] of cases) {
      await rejects(
        as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day, start_time, end_time", values)),
        /calendar_events_times_consistent/,
      ).catch((error) => assert.fail(`${name}: ${error}`));
    }
    // Equal start and end is allowed (a point in time).
    await as(db, "authenticated", USER_A, insertEvent("title, event_date, start_time, end_time", `'x', '2026-10-09', '10:00', '10:00'`));
  });

  it("rejects blank or overlong titles, blank location and description", async () => {
    await rejects(as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day", `'  ', '2026-10-09', true`)), /calendar_events_title_length/);
    await rejects(
      as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day", `'${"x".repeat(201)}', '2026-10-09', true`)),
      /calendar_events_title_length/,
    );
    await rejects(
      as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day, location", `'x', '2026-10-09', true, ' '`)),
      /calendar_events_location_length/,
    );
    await rejects(
      as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day, description", `'x', '2026-10-09', true, ''`)),
      /calendar_events_description_length/,
    );
  });

  it("rejects invalid dates and times", async () => {
    await rejects(as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day", `'x', '2026-02-30', true`)), /out of range|invalid/);
    await rejects(as(db, "authenticated", USER_A, insertEvent("title, event_date, start_time", `'x', '2026-10-09', '25:00'`)), /out of range|invalid/);
  });

  it("accepts every future source and rejects others (server-side role)", async () => {
    for (const source of ["manual", "canvas", "google-calendar", "ai"]) {
      await db.exec(`begin; insert into public.calendar_events (user_id, title, event_date, all_day, source) values ('${USER_A}', 'x', '2026-10-09', true, '${source}'); rollback;`);
    }
    await rejects(
      db.exec(`insert into public.calendar_events (user_id, title, event_date, all_day, source) values ('${USER_A}', 'x', '2026-10-09', true, 'outlook')`),
      /calendar_events_source_valid/,
    );
  });

  it("prevents importing the same external event twice per user and source", async () => {
    await db.exec(`
      insert into public.calendar_events (user_id, title, event_date, all_day, source, external_id)
      values ('${USER_A}', 'Entrega Canvas', '2026-10-23', true, 'canvas', 'asg-1'),
             ('${USER_A}', 'Mismo id, otra fuente', '2026-10-23', true, 'google-calendar', 'asg-1'),
             ('${USER_B}', 'Mismo id, otro usuario', '2026-10-23', true, 'canvas', 'asg-1');
    `);
    await rejects(
      db.exec(`insert into public.calendar_events (user_id, title, event_date, all_day, source, external_id) values ('${USER_A}', 'Otra vez', '2026-10-23', true, 'canvas', 'asg-1')`),
      /calendar_events_user_source_external_id_key/,
    );
    await rejects(
      db.exec(`insert into public.calendar_events (user_id, title, event_date, all_day, source, external_id) values ('${USER_A}', 'x', '2026-10-23', true, 'canvas', '  ')`),
      /calendar_events_external_id_not_blank/,
    );
    await db.exec(`delete from public.calendar_events where external_id = 'asg-1'`);
  });

  it("advances updated_at on update", async () => {
    const [row] = await as<{ advanced: boolean }>(
      db,
      "authenticated",
      USER_A,
      `select pg_sleep(0.01);
       update public.calendar_events set title = 'Tutoría (cambio)' where id = '${eventA}' returning updated_at > created_at as advanced`,
    );
    assert.equal(row.advanced, true);
  });
});

describe("calendar_events: privileges and RLS", () => {
  it("denies all access to anon", async () => {
    await rejects(as(db, "anon", null, `select * from public.calendar_events`), /permission denied/);
    await rejects(as(db, "anon", null, insertEvent("title, event_date, all_day", `'x', '2026-10-09', true`)), /permission denied/);
    await rejects(as(db, "anon", null, `delete from public.calendar_events`), /permission denied/);
  });

  it("shows each user only their own events", async () => {
    const rowsB = await as(db, "authenticated", USER_B, `select id from public.calendar_events`);
    assert.equal(rowsB.length, 0);
    const rowsA = await as(db, "authenticated", USER_A, `select id from public.calendar_events`);
    assert.deepEqual(rowsA.map((row) => row.id), [eventA]);
  });

  it("does not let B edit or delete A's event (0 rows)", async () => {
    assert.equal((await as(db, "authenticated", USER_B, `update public.calendar_events set title = 'x' where id = '${eventA}' returning id`)).length, 0);
    assert.equal((await as(db, "authenticated", USER_B, `delete from public.calendar_events where id = '${eventA}' returning id`)).length, 0);
  });

  it("does not let clients write owner, id, source, external_id or timestamps", async () => {
    await rejects(
      as(db, "authenticated", USER_A, insertEvent("user_id, title, event_date, all_day", `'${USER_B}', 'x', '2026-10-09', true`)),
      /permission denied/,
    );
    await rejects(
      as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day, source, external_id", `'x', '2026-10-09', true, 'canvas', 'asg-9'`)),
      /permission denied/,
    );
    for (const column of [`user_id = '${USER_B}'`, `id = gen_random_uuid()`, `source = 'ai'`, `external_id = 'x'`, `created_at = now()`, `updated_at = now()`]) {
      await rejects(
        as(db, "authenticated", USER_A, `update public.calendar_events set ${column} where id = '${eventA}'`),
        /permission denied/,
      );
    }
  });

  it("lets the owner create, edit every content field and delete", async () => {
    const [created] = await as(
      db,
      "authenticated",
      USER_A,
      `insert into public.calendar_events (title, description, event_date, start_time, end_time, all_day, location, project_id)
       values ('Crítica', 'Panel A1', '2026-10-15', '09:30', '13:30', false, 'Aula 3.2', '${projectA}') returning id`,
    );
    assert.ok(created.id);
    const [edited] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.calendar_events
         set title = 'Crítica final', description = null, event_date = '2026-10-16', start_time = null, end_time = null,
             all_day = true, location = null, project_id = null
       where id = '${eventA}' returning title, all_day, project_id`,
    );
    assert.deepEqual(edited, { title: "Crítica final", all_day: true, project_id: null });
    const deleted = await as(db, "authenticated", USER_A, `delete from public.calendar_events where id = '${eventA}' returning id`);
    assert.equal(deleted.length, 1);
  });
});

describe("calendar_events -> projects relationship", () => {
  it("rejects attaching an event to another user's project (insert and update)", async () => {
    await rejects(
      as(db, "authenticated", USER_A, insertEvent("title, event_date, all_day, project_id", `'x', '2026-10-09', true, '${projectB}'`)),
      /calendar_events_project_owner_fkey/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `update public.calendar_events set project_id = '${projectB}' where id = '${eventA}'`),
      /calendar_events_project_owner_fkey/,
    );
  });

  it("enforces matching owners even for the server-side role (no RLS)", async () => {
    await rejects(
      db.exec(`insert into public.calendar_events (user_id, title, event_date, all_day, project_id) values ('${USER_B}', 'x', '2026-10-09', true, '${projectA}')`),
      /calendar_events_project_owner_fkey/,
    );
  });

  it("deleting a project keeps its events and clears project_id", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `delete from public.projects where id = '${projectA}';
       select id, project_id, user_id, title from public.calendar_events where id = '${eventA}'`,
    );
    assert.deepEqual(rows, [{ id: eventA, project_id: null, user_id: USER_A, title: "Tutoría" }]);
  });

  it("deleting a project still keeps its tasks too", async () => {
    const rows = await as<{ project_id: string | null }>(
      db,
      "authenticated",
      USER_A,
      `insert into public.tasks (title, due_date, project_id) values ('Entrega maqueta', '2026-10-23', '${projectA}');
       delete from public.projects where id = '${projectA}';
       select project_id from public.tasks where title = 'Entrega maqueta'`,
    );
    assert.deepEqual(rows, [{ project_id: null }]);
  });
});
