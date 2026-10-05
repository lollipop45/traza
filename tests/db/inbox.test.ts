// Database-level guarantees for ideas and notes (public.inbox_items): constraints, RLS, privileges,
// the ownership-safe project link and import de-duplication; plus the rule that tasks captured
// from the Inbox live only in public.tasks.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;
let projectA: string;
let projectB: string;
let ideaA: string;

before(async () => {
  db = await createDatabase();
  [{ id: projectA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Taller de Proyectos') returning id`);
  [{ id: projectB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `insert into public.projects (name) values ('Proyecto de B') returning id`);
  [{ id: ideaA }] = await commitAs<{ id: string }>(
    db,
    "authenticated",
    USER_A,
    `insert into public.inbox_items (kind, title, content, project_id)
     values ('idea', 'Vivienda semienterrada', 'Aprovechar la inercia térmica del terreno.', '${projectA}') returning id`,
  );
});

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

const insertItem = (columns: string, values: string) => `insert into public.inbox_items (${columns}) values (${values}) returning *`;

describe("inbox_items: schema", () => {
  it("fills owner, source and timestamps from defaults", async () => {
    const [row] = await as(db, "authenticated", USER_A, `select * from public.inbox_items where id = '${ideaA}'`);
    assert.equal(row.user_id, USER_A);
    assert.equal(row.source, "manual");
    assert.equal(row.external_id, null);
    assert.ok(row.created_at instanceof Date);
  });

  it("accepts a title only, a content only, or both", async () => {
    await as(db, "authenticated", USER_A, insertItem("kind, title", `'note', 'Solo título'`));
    await as(db, "authenticated", USER_A, insertItem("kind, content", `'note', 'Solo contenido'`));
  });

  it("makes empty captures impossible", async () => {
    await rejects(as(db, "authenticated", USER_A, insertItem("kind", `'note'`)), /inbox_items_not_empty/);
    await rejects(as(db, "authenticated", USER_A, insertItem("kind, title", `'note', '   '`)), /inbox_items_title_length/);
    await rejects(as(db, "authenticated", USER_A, insertItem("kind, content", `'note', ''`)), /inbox_items_content_length/);
  });

  it("enforces lengths", async () => {
    await rejects(as(db, "authenticated", USER_A, insertItem("kind, title", `'note', '${"x".repeat(201)}'`)), /inbox_items_title_length/);
    await rejects(as(db, "authenticated", USER_A, insertItem("kind, content", `'note', '${"x".repeat(10001)}'`)), /inbox_items_content_length/);
    await as(db, "authenticated", USER_A, insertItem("kind, title, content", `'note', '${"x".repeat(200)}', '${"x".repeat(10000)}'`));
  });

  it("allows only idea and note (tasks belong in public.tasks)", async () => {
    for (const kind of ["task", "event", ""]) {
      await rejects(as(db, "authenticated", USER_A, insertItem("kind, title", `'${kind}', 'x'`)), /inbox_items_kind_valid/);
    }
  });

  it("has no task-specific columns", async () => {
    const rows = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'inbox_items'`,
    );
    const columns = rows.rows.map((row) => row.column_name);
    for (const taskColumn of ["status", "priority", "due_date", "completed_at"]) assert.ok(!columns.includes(taskColumn), taskColumn);
  });

  it("accepts manual, canvas and ai sources only (server-side role)", async () => {
    for (const source of ["manual", "canvas", "ai"]) {
      await db.exec(`begin; insert into public.inbox_items (user_id, kind, title, source) values ('${USER_A}', 'note', 'x', '${source}'); rollback;`);
    }
    await rejects(
      db.exec(`insert into public.inbox_items (user_id, kind, title, source) values ('${USER_A}', 'note', 'x', 'email')`),
      /inbox_items_source_valid/,
    );
  });

  it("prevents importing the same external item twice per user and source", async () => {
    await db.exec(`
      insert into public.inbox_items (user_id, kind, title, source, external_id)
      values ('${USER_A}', 'note', 'Anuncio', 'canvas', 'ann-1'),
             ('${USER_A}', 'note', 'Mismo id, otra fuente', 'ai', 'ann-1'),
             ('${USER_B}', 'note', 'Mismo id, otro usuario', 'canvas', 'ann-1');
    `);
    await rejects(
      db.exec(`insert into public.inbox_items (user_id, kind, title, source, external_id) values ('${USER_A}', 'note', 'Otra vez', 'canvas', 'ann-1')`),
      /inbox_items_user_source_external_id_key/,
    );
    await rejects(
      db.exec(`insert into public.inbox_items (user_id, kind, title, source, external_id) values ('${USER_A}', 'note', 'x', 'canvas', ' ')`),
      /inbox_items_external_id_not_blank/,
    );
    await db.exec(`delete from public.inbox_items where external_id = 'ann-1'`);
  });

  it("advances updated_at on update", async () => {
    const [row] = await as<{ advanced: boolean }>(
      db,
      "authenticated",
      USER_A,
      `select pg_sleep(0.01);
       update public.inbox_items set title = 'Vivienda (rev.)' where id = '${ideaA}' returning updated_at > created_at as advanced`,
    );
    assert.equal(row.advanced, true);
  });
});

describe("inbox_items: privileges and RLS", () => {
  it("denies all access to anon", async () => {
    await rejects(as(db, "anon", null, `select * from public.inbox_items`), /permission denied/);
    await rejects(as(db, "anon", null, insertItem("kind, title", `'note', 'x'`)), /permission denied/);
    await rejects(as(db, "anon", null, `delete from public.inbox_items`), /permission denied/);
  });

  it("shows each user only their own items", async () => {
    assert.equal((await as(db, "authenticated", USER_B, `select id from public.inbox_items`)).length, 0);
    assert.deepEqual((await as(db, "authenticated", USER_A, `select id from public.inbox_items`)).map((row) => row.id), [ideaA]);
  });

  it("does not let B edit or delete A's item (0 rows)", async () => {
    assert.equal((await as(db, "authenticated", USER_B, `update public.inbox_items set title = 'x' where id = '${ideaA}' returning id`)).length, 0);
    assert.equal((await as(db, "authenticated", USER_B, `delete from public.inbox_items where id = '${ideaA}' returning id`)).length, 0);
  });

  it("does not let clients write owner, id, source, external_id or timestamps", async () => {
    await rejects(as(db, "authenticated", USER_A, insertItem("user_id, kind, title", `'${USER_B}', 'note', 'x'`)), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, insertItem("kind, title, source", `'note', 'x', 'canvas'`)), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, insertItem("kind, title, external_id", `'note', 'x', 'ann-9'`)), /permission denied/);
    for (const column of [`user_id = '${USER_B}'`, `id = gen_random_uuid()`, `source = 'ai'`, `external_id = 'x'`, `created_at = now()`, `updated_at = now()`]) {
      await rejects(as(db, "authenticated", USER_A, `update public.inbox_items set ${column} where id = '${ideaA}'`), /permission denied/);
    }
  });

  it("lets the owner edit kind, title, content and project, and delete", async () => {
    const [edited] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.inbox_items set kind = 'note', title = null, content = 'Ahora es una nota', project_id = null
       where id = '${ideaA}' returning kind, title, content, project_id`,
    );
    assert.deepEqual(edited, { kind: "note", title: null, content: "Ahora es una nota", project_id: null });
    assert.equal((await as(db, "authenticated", USER_A, `delete from public.inbox_items where id = '${ideaA}' returning id`)).length, 1);
  });

  it("cannot be edited into an empty capture", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `update public.inbox_items set title = null, content = null where id = '${ideaA}'`),
      /inbox_items_not_empty/,
    );
  });
});

describe("inbox_items -> projects relationship", () => {
  it("rejects attaching an item to another user's project (insert and update)", async () => {
    await rejects(
      as(db, "authenticated", USER_A, insertItem("kind, title, project_id", `'idea', 'x', '${projectB}'`)),
      /inbox_items_project_owner_fkey/,
    );
    await rejects(
      as(db, "authenticated", USER_A, `update public.inbox_items set project_id = '${projectB}' where id = '${ideaA}'`),
      /inbox_items_project_owner_fkey/,
    );
  });

  it("enforces matching owners even for the server-side role (no RLS)", async () => {
    await rejects(
      db.exec(`insert into public.inbox_items (user_id, kind, title, project_id) values ('${USER_B}', 'idea', 'x', '${projectA}')`),
      /inbox_items_project_owner_fkey/,
    );
  });

  it("deleting a project keeps its ideas and notes and clears project_id", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `delete from public.projects where id = '${projectA}';
       select id, project_id, user_id, title from public.inbox_items where id = '${ideaA}'`,
    );
    assert.deepEqual(rows, [{ id: ideaA, project_id: null, user_id: USER_A, title: "Vivienda semienterrada" }]);
  });
});

describe("tasks captured from the Inbox", () => {
  it("are ordinary rows of public.tasks, the same records Home reads", async () => {
    const rows = await as<{ in_tasks: number; in_inbox: number; home_sees: number }>(
      db,
      "authenticated",
      USER_A,
      `insert into public.tasks (title, project_id) values ('Comprar cartón pluma', '${projectA}');
       select (select count(*)::int from public.tasks where title = 'Comprar cartón pluma') as in_tasks,
              (select count(*)::int from public.inbox_items where title = 'Comprar cartón pluma') as in_inbox,
              (select count(*)::int from public.tasks where user_id = '${USER_A}' and status = 'pending') as home_sees`,
    );
    assert.deepEqual(rows, [{ in_tasks: 1, in_inbox: 0, home_sees: 1 }]);
  });
});
