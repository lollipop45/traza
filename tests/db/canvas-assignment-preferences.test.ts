// Database-level guarantees for per-assignment Canvas decisions (public.canvas_assignment_preferences),
// the atomic set_canvas_assignment_preference function and the ignore guard in the sync function.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;
let tallerA: string;
let projectB: string;

const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
const sync = (courseId: string, assignments: unknown[]) =>
  `select assignment_id, outcome from public.sync_canvas_course_tasks('${courseId}', ${json(assignments)})`;
const setPref = (courseId: string, assignmentId: string, state: string, name: string | null = null) =>
  `select public.set_canvas_assignment_preference(p_canvas_course_id => '${courseId}', p_canvas_assignment_id => '${assignmentId}', p_state => '${state}'${
    name === null ? "" : `, p_canvas_assignment_name => '${name}'`
  }) as removed`;
const notas = { assignment_id: "9001", title: "NOTAS FINALES AUDS", due_date: null };
const panel = { assignment_id: "7001", title: "Panel análisis territorial", due_date: "2026-10-12" };

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

before(async () => {
  db = await createDatabase();
  [{ id: tallerA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Taller de Proyectos') returning id`);
  [{ id: projectB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `insert into public.projects (name) values ('Proyecto de B') returning id`);
  await commitAs(db, "authenticated", USER_A, `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('145580', '${tallerA}', 'linked')`);
  await commitAs(db, "authenticated", USER_B, `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('145580', '${projectB}', 'linked')`);
  // A false positive imported by the first sync, for both users, plus a real task.
  await commitAs(db, "authenticated", USER_A, sync("145580", [notas, panel]));
  await commitAs(db, "authenticated", USER_B, sync("145580", [notas]));
});

describe("canvas_assignment_preferences: schema", () => {
  it("stores one decision per user, course and assignment, owned by the caller", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `insert into public.canvas_assignment_preferences (canvas_course_id, canvas_assignment_id, state, canvas_assignment_name)
       values ('145580', '1', 'included', 'Extra Parcial 1') returning user_id, state`,
    );
    assert.deepEqual(rows, [{ user_id: USER_A, state: "included" }]);
    await rejects(
      as(
        db,
        "authenticated",
        USER_A,
        `insert into public.canvas_assignment_preferences (canvas_course_id, canvas_assignment_id, state) values ('145580', '1', 'ignored');
         insert into public.canvas_assignment_preferences (canvas_course_id, canvas_assignment_id, state) values ('145580', '1', 'included')`,
      ),
      /canvas_assignment_preferences_user_assignment_key/,
    );
  });

  it("validates ids, state and name", async () => {
    const insert = (course: string, assignment: string, state: string, name = "null") =>
      `insert into public.canvas_assignment_preferences (canvas_course_id, canvas_assignment_id, state, canvas_assignment_name) values ('${course}', '${assignment}', '${state}', ${name})`;
    await rejects(as(db, "authenticated", USER_A, insert("x1", "1", "ignored")), /course_id_format/);
    await rejects(as(db, "authenticated", USER_A, insert("1", "NOTAS", "ignored")), /assignment_id_format/);
    await rejects(as(db, "authenticated", USER_A, insert("1", "1", "hidden")), /state_valid/);
    await rejects(as(db, "authenticated", USER_A, insert("1", "1", "ignored", "'  '")), /name_length/);
  });
});

describe("canvas_assignment_preferences: privileges and RLS", () => {
  it("denies all access to anon", async () => {
    await rejects(as(db, "anon", null, `select * from public.canvas_assignment_preferences`), /permission denied/);
    await rejects(as(db, "anon", null, `insert into public.canvas_assignment_preferences (canvas_course_id, canvas_assignment_id, state) values ('1', '1', 'ignored')`), /permission denied/);
    await rejects(as(db, "anon", null, setPref("145580", "9001", "ignored")), /permission denied/);
  });

  it("isolates users: B never sees, changes or deletes A's decisions", async () => {
    await commitAs(db, "authenticated", USER_A, setPref("145580", "5", "ignored", "Asistencia"));
    try {
      assert.equal((await as(db, "authenticated", USER_B, `select id from public.canvas_assignment_preferences`)).length, 0);
      assert.equal((await as(db, "authenticated", USER_B, `update public.canvas_assignment_preferences set state = 'included' returning id`)).length, 0);
      assert.equal((await as(db, "authenticated", USER_B, `delete from public.canvas_assignment_preferences returning id`)).length, 0);
    } finally {
      await db.exec(`delete from public.canvas_assignment_preferences`);
    }
  });

  it("does not let clients write the owner, ids or timestamps", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.canvas_assignment_preferences (user_id, canvas_course_id, canvas_assignment_id, state) values ('${USER_B}', '1', '1', 'ignored')`),
      /permission denied/,
    );
    for (const column of [`user_id = '${USER_B}'`, `canvas_course_id = '2'`, `canvas_assignment_id = '2'`, `created_at = now()`]) {
      await rejects(
        as(
          db,
          "authenticated",
          USER_A,
          `insert into public.canvas_assignment_preferences (canvas_course_id, canvas_assignment_id, state) values ('1', '1', 'ignored');
           update public.canvas_assignment_preferences set ${column}`,
        ),
        /permission denied/,
      );
    }
  });
});

describe("set_canvas_assignment_preference", () => {
  it("ignoring records the decision and removes the imported task atomically", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${setPref("145580", "9001", "ignored", "NOTAS FINALES AUDS")};
       select (select count(*)::int from public.tasks where external_id = 'course:145580:assignment:9001') as task,
              (select count(*)::int from public.tasks where source = 'canvas') as canvas_tasks,
              (select state from public.canvas_assignment_preferences where canvas_assignment_id = '9001') as state,
              (select canvas_assignment_name from public.canvas_assignment_preferences where canvas_assignment_id = '9001') as name`,
    );
    assert.deepEqual(rows, [{ task: 0, canvas_tasks: 1, state: "ignored", name: "NOTAS FINALES AUDS" }]);
    const [{ removed }] = await as<{ removed: number }>(db, "authenticated", USER_A, setPref("145580", "9001", "ignored"));
    assert.equal(removed, 1);
  });

  it("never touches B's matching task or B's decisions", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${setPref("145580", "9001", "ignored")};
       select count(*)::int as n from public.canvas_assignment_preferences`,
    );
    assert.deepEqual(rows, [{ n: 1 }]);
    const [b] = await db.query<{ n: number }>(`select count(*)::int as n from public.tasks where user_id = '${USER_B}' and external_id = 'course:145580:assignment:9001'`).then((r) => r.rows);
    assert.equal(b.n, 1);
  });

  it("never removes a manual task, even one with the same title", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `insert into public.tasks (title) values ('NOTAS FINALES AUDS');
       ${setPref("145580", "9001", "ignored")};
       select title, source from public.tasks where title = 'NOTAS FINALES AUDS'`,
    );
    assert.deepEqual(rows, [{ title: "NOTAS FINALES AUDS", source: "manual" }]);
  });

  it("including removes nothing; switching back keeps one row; the name survives a null", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${setPref("145580", "7001", "included", "Panel")};
       ${setPref("145580", "7001", "included")};
       select (select count(*)::int from public.tasks where external_id = 'course:145580:assignment:7001') as task,
              (select count(*)::int from public.canvas_assignment_preferences) as prefs,
              (select canvas_assignment_name from public.canvas_assignment_preferences) as name`,
    );
    assert.deepEqual(rows, [{ task: 1, prefs: 1, name: "Panel" }]);
  });

  it("rejects bad input and unauthenticated callers, writing nothing", async () => {
    await rejects(as(db, "authenticated", null, setPref("145580", "9001", "ignored")), /Not authenticated/);
    await rejects(as(db, "authenticated", USER_A, setPref("145580", "9001 or 1=1", "ignored")), /assignment_id_format/);
    await rejects(as(db, "authenticated", USER_A, setPref("145580", "9001", "deleted")), /state_valid/);
    const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from public.tasks where external_id = 'course:145580:assignment:9001'`).then((r) => r.rows);
    assert.equal(n, 2);
  });

  it("runs as SECURITY INVOKER with an empty search_path, executable only by authenticated", async () => {
    const [fn] = await db
      .query<{ prosecdef: boolean; proconfig: string[]; anon: boolean; auth: boolean }>(
        `select prosecdef, proconfig, has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as auth
           from pg_proc where proname = 'set_canvas_assignment_preference'`,
      )
      .then((r) => r.rows);
    assert.deepEqual(fn, { prosecdef: false, proconfig: ['search_path=""'], anon: false, auth: true });
  });
});

describe("sync_canvas_course_tasks honours ignored assignments", () => {
  it("never recreates an ignored assignment, however many syncs run", async () => {
    const rows = await as<{ outcome: string; n: number }>(
      db,
      "authenticated",
      USER_A,
      `${setPref("145580", "9001", "ignored")};
       create temp table outcomes (assignment_id text, outcome text);
       ${Array.from({ length: 5 }, () => `insert into outcomes ${sync("145580", [notas, panel])};`).join("\n")}
       select outcome, count(*)::int as n from outcomes group by outcome
       union all select 'tasks-9001', count(*)::int from public.tasks where external_id = 'course:145580:assignment:9001'
       order by 1`,
    );
    assert.deepEqual(rows, [
      { outcome: "ignored", n: 5 },
      { outcome: "tasks-9001", n: 0 },
      { outcome: "unchanged", n: 5 },
    ]);
  });

  it("restoring (deleting the decision) makes it eligible again", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${setPref("145580", "9001", "ignored")};
       delete from public.canvas_assignment_preferences where canvas_assignment_id = '9001';
       ${sync("145580", [notas])}`,
    );
    assert.deepEqual(rows, [{ assignment_id: "9001", outcome: "created" }]);
  });

  it("an ignore by A does not stop B's sync", async () => {
    await commitAs(db, "authenticated", USER_A, setPref("145580", "7002", "ignored"));
    try {
      const rows = await as(db, "authenticated", USER_B, sync("145580", [{ ...panel, assignment_id: "7002" }]));
      assert.deepEqual(rows, [{ assignment_id: "7002", outcome: "created" }]);
    } finally {
      await db.exec(`delete from public.canvas_assignment_preferences`);
    }
  });

  it("keeps the sync function SECURITY DEFINER and executable only by authenticated", async () => {
    const [fn] = await db
      .query<{ prosecdef: boolean; anon: boolean; auth: boolean }>(
        `select prosecdef, has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as auth
           from pg_proc where proname = 'sync_canvas_course_tasks'`,
      )
      .then((r) => r.rows);
    assert.deepEqual(fn, { prosecdef: true, anon: false, auth: true });
  });
});
