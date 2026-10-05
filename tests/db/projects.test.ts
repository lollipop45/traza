// Database-level guarantees for projects and the task -> project relationship. These hold no
// matter which client talks to the Data API, so they are tested in SQL, not through the app.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;
let projectA: string;
let archivedA: string;
let projectB: string;
let taskA: string;

const insertProject = (name: string, extra = "") =>
  `insert into public.projects (name${extra ? ", status" : ""}) values ('${name}'${extra ? `, '${extra}'` : ""}) returning id`;

before(async () => {
  db = await createDatabase();
  // Fixtures go through the real grants and policies, as each user.
  [{ id: projectA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, insertProject("Taller de Proyectos"));
  [{ id: archivedA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, insertProject("Archivo académico", "archived"));
  [{ id: projectB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, insertProject("Proyecto de B"));
  [{ id: taskA }] = await commitAs<{ id: string }>(
    db,
    "authenticated",
    USER_A,
    `insert into public.tasks (title, project_id) values ('Imprimir A1', '${projectA}') returning id`,
  );
});

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

describe("projects: schema", () => {
  it("fills owner, status, progress, source and timestamps from defaults", async () => {
    const [row] = await as(db, "authenticated", USER_A, `select * from public.projects where id = '${projectA}'`);
    assert.equal(row.user_id, USER_A);
    assert.equal(row.status, "active");
    assert.equal(row.progress, 0);
    assert.equal(row.source, "manual");
    assert.equal(row.area, null);
    assert.equal(row.description, null);
    assert.ok(row.created_at instanceof Date);
  });

  it("rejects blank or overlong names", async () => {
    await rejects(as(db, "authenticated", USER_A, insertProject("   ")), /projects_name_length/);
    await rejects(as(db, "authenticated", USER_A, insertProject("x".repeat(121))), /projects_name_length/);
    await as(db, "authenticated", USER_A, insertProject("x".repeat(120)));
  });

  it("rejects invalid status, progress, blank area and overlong area", async () => {
    await rejects(as(db, "authenticated", USER_A, insertProject("P", "paused")), /projects_status_valid/);
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.projects (name, progress) values ('P', 101)`),
      /projects_progress_range/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.projects (name, progress) values ('P', -1)`),
      /projects_progress_range/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.projects (name, area) values ('P', '  ')`),
      /projects_area_length/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.projects (name, area) values ('P', '${"a".repeat(61)}')`),
      /projects_area_length/,
    );
  });

  it("rejects an invalid source (as the server-side role)", async () => {
    await rejects(
      db.exec(`insert into public.projects (user_id, name, source) values ('${USER_A}', 'P', 'google')`),
      /projects_source_valid/,
    );
  });

  it("advances updated_at on update", async () => {
    const [row] = await as<{ advanced: boolean }>(
      db,
      "authenticated",
      USER_A,
      `select pg_sleep(0.01);
       update public.projects set progress = 50 where id = '${projectA}' returning updated_at > created_at as advanced`,
    );
    assert.equal(row.advanced, true);
  });
});

describe("projects: privileges and RLS", () => {
  it("denies all access to anon", async () => {
    await rejects(as(db, "anon", null, `select * from public.projects`), /permission denied/);
    await rejects(as(db, "anon", null, insertProject("P")), /permission denied/);
    await rejects(as(db, "anon", null, `delete from public.projects`), /permission denied/);
  });

  it("shows each user only their own projects", async () => {
    const rowsA = await as<{ user_id: string }>(db, "authenticated", USER_A, `select user_id from public.projects`);
    assert.equal(rowsA.length, 2);
    assert.ok(rowsA.every((row) => row.user_id === USER_A));
    const rowsB = await as(db, "authenticated", USER_B, `select id from public.projects where id = '${projectA}'`);
    assert.equal(rowsB.length, 0);
  });

  it("does not let B edit or delete A's project (0 rows)", async () => {
    const updated = await as(db, "authenticated", USER_B, `update public.projects set name = 'Hijacked' where id = '${projectA}' returning id`);
    assert.equal(updated.length, 0);
    const deleted = await as(db, "authenticated", USER_B, `delete from public.projects where id = '${projectA}' returning id`);
    assert.equal(deleted.length, 0);
  });

  it("does not let a user create a project for someone else", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.projects (user_id, name) values ('${USER_B}', 'P')`),
      /permission denied/,
    );
  });

  it("does not let project ownership, id, source or timestamps change", async () => {
    for (const column of [`user_id = '${USER_B}'`, `id = gen_random_uuid()`, `source = 'ai'`, `created_at = now()`]) {
      await rejects(
        as(db, "authenticated", USER_A, `update public.projects set ${column} where id = '${projectA}'`),
        /permission denied/,
      );
    }
  });

  it("lets the owner edit content fields and archive", async () => {
    const [row] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.projects
         set name = 'Taller IV', area = 'Arquitectura', description = 'Vivienda', status = 'archived', progress = 100
       where id = '${projectA}' returning name, area, status, progress`,
    );
    assert.deepEqual(row, { name: "Taller IV", area: "Arquitectura", status: "archived", progress: 100 });
  });

  it("filters by status within the owner's rows", async () => {
    const rows = await as<{ status: string; n: number }>(
      db,
      "authenticated",
      USER_A,
      `select status, count(*)::int as n from public.projects group by status order by status`,
    );
    assert.deepEqual(rows, [
      { status: "active", n: 1 },
      { status: "archived", n: 1 },
    ]);
  });
});

describe("tasks -> projects relationship", () => {
  it("lets a user assign, change and remove their own project", async () => {
    const [assigned] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.tasks set project_id = '${archivedA}' where id = '${taskA}' returning project_id`,
    );
    assert.equal(assigned.project_id, archivedA);
    const [removed] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.tasks set project_id = null where id = '${taskA}' returning project_id`,
    );
    assert.equal(removed.project_id, null);
  });

  it("rejects attaching a task to another user's project (insert and update)", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.tasks (title, project_id) values ('x', '${projectB}')`),
      /tasks_project_owner_fkey/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `update public.tasks set project_id = '${projectB}' where id = '${taskA}'`),
      /tasks_project_owner_fkey/,
    );
  });

  it("rejects a project id that does not exist", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.tasks (title, project_id) values ('x', gen_random_uuid())`),
      /tasks_project_owner_fkey/,
    );
  });

  it("enforces matching owners even for the server-side role (no RLS)", async () => {
    await rejects(
      db.exec(`insert into public.tasks (user_id, title, project_id) values ('${USER_B}', 'x', '${projectA}')`),
      /tasks_project_owner_fkey/,
    );
  });

  it("does not let task ownership change", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `update public.tasks set user_id = '${USER_B}' where id = '${taskA}'`),
      /permission denied/,
    );
  });

  it("deleting a project keeps its tasks and clears project_id", async () => {
    const rows = await as<{ id: string; project_id: string | null; user_id: string; title: string }>(
      db,
      "authenticated",
      USER_A,
      `delete from public.projects where id = '${projectA}';
       select id, project_id, user_id, title from public.tasks where id = '${taskA}'`,
    );
    assert.deepEqual(rows, [{ id: taskA, project_id: null, user_id: USER_A, title: "Imprimir A1" }]);
  });

  it("derives task counts per project from tasks", async () => {
    const rows = await as<{ project_id: string; total: number; pending: number }>(
      db,
      "authenticated",
      USER_A,
      `insert into public.tasks (title, project_id, status, completed_at) values ('Hecha', '${projectA}', 'done', now());
       insert into public.tasks (title, project_id) values ('Pendiente', '${projectA}');
       select project_id, count(*)::int as total, count(*) filter (where status = 'pending')::int as pending
         from public.tasks where project_id is not null group by project_id`,
    );
    assert.deepEqual(rows, [{ project_id: projectA, total: 3, pending: 2 }]);
  });
});

describe("tasks: tightened grants", () => {
  it("no longer lets clients write source or external_id", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.tasks (title, source) values ('x', 'canvas')`),
      /permission denied/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `update public.tasks set external_id = 'asg-1' where id = '${taskA}'`),
      /permission denied/,
    );
  });

  it("still allows every field the app writes", async () => {
    const [row] = await as(
      db,
      "authenticated",
      USER_A,
      `insert into public.tasks (title, due_date, priority, project_id) values ('Nueva', '2026-10-07', 'high', '${projectA}')
       returning source;`,
    );
    assert.equal(row.source, "manual");
    const [updated] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.tasks
         set title = 'Editada', due_date = null, priority = 'low', project_id = null, status = 'done', completed_at = now()
       where id = '${taskA}' returning status`,
    );
    assert.equal(updated.status, "done");
    const deleted = await as(db, "authenticated", USER_A, `delete from public.tasks where id = '${taskA}' returning id`);
    assert.equal(deleted.length, 1);
  });

  it("keeps tasks private to their owner", async () => {
    const rows = await as(db, "authenticated", USER_B, `select id from public.tasks`);
    assert.equal(rows.length, 0);
    await rejects(as(db, "anon", null, `select id from public.tasks`), /permission denied/);
  });
});
