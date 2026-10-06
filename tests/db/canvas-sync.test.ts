// Database-level guarantees for the Canvas assignment -> task write path
// (public.sync_canvas_course_tasks).
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;
let tallerA: string;
let dibujoA: string;
let projectB: string;

type Assignment = { assignment_id: unknown; title?: unknown; due_date?: unknown; submitted?: unknown };

const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
const sync = (courseId: string, assignments: Assignment[] | unknown) =>
  `select assignment_id, outcome from public.sync_canvas_course_tasks(p_canvas_course_id => '${courseId}', p_assignments => ${json(assignments)})`;
const canvasTasks = `select title, due_date::text as due_date, project_id, status, priority, source, external_id, completed_at is not null as completed
                       from public.tasks where source = 'canvas' order by external_id`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

before(async () => {
  db = await createDatabase();
  [{ id: tallerA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Taller de Proyectos') returning id`);
  [{ id: dibujoA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Dibujo III') returning id`);
  [{ id: projectB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `insert into public.projects (name) values ('Proyecto de B') returning id`);
  await commitAs(
    db,
    "authenticated",
    USER_A,
    `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('145580', '${tallerA}', 'linked');
     insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('145581', '${dibujoA}', 'linked');
     insert into public.canvas_course_links (canvas_course_id, state) values ('900', 'ignored')`,
  );
  await commitAs(db, "authenticated", USER_B, `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('145580', '${projectB}', 'linked')`);
});

const panel = { assignment_id: "7001", title: "Panel análisis territorial", due_date: "2026-10-12", submitted: false };

describe("sync_canvas_course_tasks: import", () => {
  it("creates a canvas task in the linked project, owned by the caller, with a stable external id", async () => {
    const rows = await as(db, "authenticated", USER_A, `${sync("145580", [panel])}; ${canvasTasks}`);
    assert.deepEqual(rows, [
      {
        title: "Panel análisis territorial",
        due_date: "2026-10-12",
        project_id: tallerA,
        status: "pending",
        priority: "normal",
        source: "canvas",
        external_id: "course:145580:assignment:7001",
        completed: false,
      },
    ]);
    const [owner] = await as(db, "authenticated", USER_A, `${sync("145580", [panel])}; select user_id from public.tasks where source = 'canvas'`);
    assert.equal(owner.user_id, USER_A);
  });

  it("reports created, then unchanged: repeating the sync never duplicates", async () => {
    const rows = await as<{ outcome: string; n: number }>(
      db,
      "authenticated",
      USER_A,
      `create temp table outcomes (run int, assignment_id text, outcome text);
       insert into outcomes select 1, * from public.sync_canvas_course_tasks('145580', ${json([panel])});
       ${Array.from({ length: 9 }, (_, i) => `insert into outcomes select ${i + 2}, * from public.sync_canvas_course_tasks('145580', ${json([panel])});`).join("\n")}
       select outcome, count(*)::int as n from outcomes group by outcome
       union all select 'tasks', count(*)::int from public.tasks where source = 'canvas'
       order by 1`,
    );
    assert.deepEqual(rows, [
      { outcome: "created", n: 1 },
      { outcome: "tasks", n: 1 },
      { outcome: "unchanged", n: 9 },
    ]);
  });

  it("keeps assignments with similar names distinct, and the same id in two courses apart", async () => {
    const rows = await as<{ external_id: string; project_id: string }>(
      db,
      "authenticated",
      USER_A,
      `${sync("145580", [panel, { assignment_id: "7002", title: "Panel análisis territorial", due_date: null }])};
       ${sync("145581", [{ assignment_id: "7001", title: "Panel análisis territorial", due_date: "2026-10-12" }])};
       select external_id, project_id from public.tasks where source = 'canvas' order by external_id`,
    );
    assert.deepEqual(rows, [
      { external_id: "course:145580:assignment:7001", project_id: tallerA },
      { external_id: "course:145580:assignment:7002", project_id: tallerA },
      { external_id: "course:145581:assignment:7001", project_id: dibujoA },
    ]);
  });

  it("imports an undated assignment without inventing a deadline", async () => {
    const [row] = await as(db, "authenticated", USER_A, `${sync("145580", [{ assignment_id: "8", title: "Lecturas" }])}; ${canvasTasks}`);
    assert.equal(row.due_date, null);
  });

  it("imports a submitted assignment as done", async () => {
    const [row] = await as(db, "authenticated", USER_A, `${sync("145580", [{ ...panel, submitted: true }])}; ${canvasTasks}`);
    assert.deepEqual([row.status, row.completed], ["done", true]);
  });

  it("trims the title, and enforces the task title constraint", async () => {
    const [row] = await as(db, "authenticated", USER_A, `${sync("145580", [{ ...panel, title: "  Maqueta  " }])}; ${canvasTasks}`);
    assert.equal(row.title, "Maqueta");
    await rejects(as(db, "authenticated", USER_A, sync("145580", [{ ...panel, title: "   " }])), /tasks_title_not_blank/);
    await rejects(as(db, "authenticated", USER_A, sync("145580", [{ ...panel, title: "x".repeat(501) }])), /tasks_title_not_blank/);
  });
});

describe("sync_canvas_course_tasks: updates", () => {
  async function seeded(extraSql: string) {
    return as<Record<string, unknown>>(
      db,
      "authenticated",
      USER_A,
      `${sync("145580", [panel])};
       ${extraSql};
       ${canvasTasks}`,
    );
  }

  it("follows a changed title and due date (one task, moved to 15 OCT)", async () => {
    const rows = await as<{ outcome: string }>(
      db,
      "authenticated",
      USER_A,
      `${sync("145580", [panel])}; ${sync("145580", [{ ...panel, title: "Panel análisis territorial (v2)", due_date: "2026-10-15" }])}`,
    );
    assert.deepEqual(rows, [{ assignment_id: "7001", outcome: "updated" }]);
    const tasks = await seeded(`select * from public.sync_canvas_course_tasks('145580', ${json([{ ...panel, due_date: "2026-10-15" }])})`);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].due_date, "2026-10-15");
  });

  it("clears a due date Canvas removed", async () => {
    const [task] = await seeded(`select * from public.sync_canvas_course_tasks('145580', ${json([{ ...panel, due_date: null }])})`);
    assert.equal(task.due_date, null);
  });

  it("moves the task when the course is linked to another project", async () => {
    const [task] = await seeded(
      `update public.canvas_course_links set project_id = '${dibujoA}' where canvas_course_id = '145580';
       select * from public.sync_canvas_course_tasks('145580', ${json([panel])})`,
    );
    assert.equal(task.project_id, dibujoA);
  });

  it("preserves the user's priority and description", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${sync("145580", [panel])};
       update public.tasks set priority = 'high', description = 'Mis notas' where source = 'canvas';
       ${sync("145580", [{ ...panel, title: "Nuevo título" }])};
       select title, priority, description from public.tasks where source = 'canvas'`,
    );
    assert.deepEqual(rows, [{ title: "Nuevo título", priority: "high", description: "Mis notas" }]);
  });

  it("marks a pending task done on proven submission, and never reverts a done task", async () => {
    const done = await seeded(`select * from public.sync_canvas_course_tasks('145580', ${json([{ ...panel, submitted: true }])})`);
    assert.deepEqual([done[0].status, done[0].completed], ["done", true]);

    // Completed by the user in TRAZA; Canvas still says "not submitted": stays done.
    const [kept] = await seeded(
      `update public.tasks set status = 'done', completed_at = now() where source = 'canvas';
       select * from public.sync_canvas_course_tasks('145580', ${json([{ ...panel, submitted: false }])})`,
    );
    assert.deepEqual([kept.status, kept.completed], ["done", true]);

    // Missing or null submission flags never complete anything.
    const [pending] = await seeded(`select * from public.sync_canvas_course_tasks('145580', ${json([{ ...panel, submitted: null }])})`);
    assert.equal(pending.status, "pending");
  });

  it("leaves tasks Canvas no longer returns untouched", async () => {
    const tasks = await seeded(`select * from public.sync_canvas_course_tasks('145580', '[]'::jsonb)`);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, panel.title);
  });

  it("stays one task under repeated upserts in one transaction (concurrency-like)", async () => {
    const rows = await as<{ n: number }>(
      db,
      "authenticated",
      USER_A,
      `${sync("145580", [panel, panel, { ...panel, due_date: "2026-10-13" }, panel])};
       select count(*)::int as n from public.tasks where source = 'canvas'`,
    );
    assert.deepEqual(rows, [{ n: 1 }]);
  });
});

describe("sync_canvas_course_tasks: security", () => {
  it("cannot be used by anon", async () => {
    await rejects(as(db, "anon", null, sync("145580", [panel])), /permission denied/);
  });

  it("rejects a signed-in role without a user id", async () => {
    await rejects(as(db, "authenticated", null, sync("145580", [panel])), /Not authenticated/);
  });

  it("only syncs courses the caller linked: not ignored, unmapped or someone else's", async () => {
    await rejects(as(db, "authenticated", USER_A, sync("900", [panel])), /not linked/);
    await rejects(as(db, "authenticated", USER_A, sync("424242", [panel])), /not linked/);
    // B linked 145580 too: B's call lands in B's project, never A's.
    const rows = await as(db, "authenticated", USER_B, `${sync("145580", [panel])}; select user_id, project_id from public.tasks where source = 'canvas'`);
    assert.deepEqual(rows, [{ user_id: USER_B, project_id: projectB }]);
  });

  it("never touches another user's task with the same external id", async () => {
    await commitAs(db, "authenticated", USER_B, sync("145580", [{ ...panel, title: "Tarea de B" }]));
    try {
      const rows = await as<{ outcome: string }>(db, "authenticated", USER_A, sync("145580", [{ ...panel, title: "Intento de A" }]));
      assert.deepEqual(rows, [{ assignment_id: "7001", outcome: "created" }]);
      const [b] = await as(db, "authenticated", USER_B, `select title, priority from public.tasks where source = 'canvas'`);
      assert.deepEqual(b, { title: "Tarea de B", priority: "normal" });
    } finally {
      await db.exec(`delete from public.tasks where user_id = '${USER_B}'`);
    }
  });

  it("cannot mutate a manual task", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `insert into public.tasks (title) values ('Panel análisis territorial');
       ${sync("145580", [{ ...panel, title: "Cambiado" }])};
       select title, source, external_id from public.tasks order by source`,
    );
    assert.deepEqual(rows, [
      { title: "Cambiado", source: "canvas", external_id: "course:145580:assignment:7001" },
      { title: "Panel análisis territorial", source: "manual", external_id: null },
    ]);
  });

  it("accepts no user id, project id or external id from the caller", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${sync("145580", [{ ...panel, user_id: USER_B, project_id: projectB, external_id: "evil", source: "manual" }])};
       select user_id, project_id, external_id, source from public.tasks where source = 'canvas'`,
    );
    assert.deepEqual(rows, [{ user_id: USER_A, project_id: tallerA, external_id: "course:145580:assignment:7001", source: "canvas" }]);
    // The function signature has no such parameters at all.
    await rejects(as(db, "authenticated", USER_A, `select * from public.sync_canvas_course_tasks(p_canvas_course_id => '145580', p_assignments => '[]', p_user_id => '${USER_B}')`), /does not exist/);
  });

  it("keeps the normal task privileges: clients still cannot write source or external_id", async () => {
    await rejects(as(db, "authenticated", USER_A, `insert into public.tasks (title, source, external_id) values ('x', 'canvas', 'course:1:assignment:1')`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `update public.tasks set source = 'canvas'`), /permission denied/);
  });

  it("rejects malformed payloads and writes nothing", async () => {
    const bad: unknown[] = [
      { not: "an array" },
      [42],
      [{ assignment_id: 7001, title: "Número" }],
      [{ assignment_id: "7001; drop table x", title: "x" }],
      [{ assignment_id: "1".repeat(21), title: "x" }],
      [{ assignment_id: "1" }],
      [{ assignment_id: "1", title: 5 }],
      [{ assignment_id: "1", title: "x", due_date: "12/10/2026" }],
      [{ assignment_id: "1", title: "x", due_date: "2026-02-30" }],
      [{ assignment_id: "1", title: "x", due_date: "1999-12-31" }],
      [{ assignment_id: "1", title: "x", submitted: "yes" }],
      Array.from({ length: 501 }, (_, i) => ({ assignment_id: String(i), title: "x" })),
    ];
    for (const payload of bad) {
      await assert.rejects(as(db, "authenticated", USER_A, sync("145580", payload)), JSON.stringify(payload).slice(0, 60));
    }
    // A bad element after a good one: the whole call is rolled back.
    const rows = await as<{ n: number }>(
      db,
      "authenticated",
      USER_A,
      `savepoint s;
       do $$ begin
         perform public.sync_canvas_course_tasks('145580', ${json([panel, { assignment_id: "x", title: "y" }])});
       exception when invalid_parameter_value then null;
       end $$;
       select count(*)::int as n from public.tasks where source = 'canvas'`,
    );
    assert.deepEqual(rows, [{ n: 0 }]);
    await rejects(as(db, "authenticated", USER_A, sync("14558a", [panel])), /Invalid Canvas course id/);
  });

  it("runs as SECURITY DEFINER with an empty search_path, executable only by authenticated", async () => {
    const [fn] = await db
      .query<{ prosecdef: boolean; proconfig: string[]; anon: boolean; auth: boolean; pub: boolean }>(
        `select prosecdef, proconfig,
                has_function_privilege('anon', oid, 'execute') as anon,
                has_function_privilege('authenticated', oid, 'execute') as auth,
                exists (select 1 from aclexplode(proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
           from pg_proc where proname = 'sync_canvas_course_tasks'`,
      )
      .then((r) => r.rows);
    assert.deepEqual(fn, { prosecdef: true, proconfig: ['search_path=""'], anon: false, auth: true, pub: false });
  });
});
