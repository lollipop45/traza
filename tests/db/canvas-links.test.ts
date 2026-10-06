// Database-level guarantees for Canvas course -> project decisions (public.canvas_course_links)
// and the atomic create_project_from_canvas_course function.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;
let projectA: string;
let project2A: string;
let projectB: string;

before(async () => {
  db = await createDatabase();
  [{ id: projectA }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Taller de Proyectos') returning id`);
  [{ id: project2A }] = await commitAs<{ id: string }>(db, "authenticated", USER_A, `insert into public.projects (name) values ('Dibujo III') returning id`);
  [{ id: projectB }] = await commitAs<{ id: string }>(db, "authenticated", USER_B, `insert into public.projects (name) values ('Proyecto de B') returning id`);
  await commitAs(
    db,
    "authenticated",
    USER_A,
    `insert into public.canvas_course_links (canvas_course_id, project_id, state, canvas_course_name, canvas_course_code)
     values ('145580', '${projectA}', 'linked', 'TALLER DE PROYECTOS G1', 'TP-G1')`,
  );
});

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

const link = (courseId: string, state: string, projectId: string | null) =>
  `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('${courseId}', ${projectId ? `'${projectId}'` : "null"}, '${state}') returning *`;

describe("canvas_course_links: schema", () => {
  it("fills owner and timestamps from defaults", async () => {
    const [row] = await as(db, "authenticated", USER_A, `select * from public.canvas_course_links where canvas_course_id = '145580'`);
    assert.equal(row.user_id, USER_A);
    assert.equal(row.state, "linked");
    assert.equal(row.canvas_course_name, "TALLER DE PROYECTOS G1");
    assert.ok(row.created_at instanceof Date);
  });

  it("linked requires a project; ignored forbids one", async () => {
    await rejects(as(db, "authenticated", USER_A, link("1", "linked", null)), /canvas_course_links_state_project/);
    await rejects(as(db, "authenticated", USER_A, link("1", "ignored", projectA)), /canvas_course_links_state_project/);
    await as(db, "authenticated", USER_A, link("1", "ignored", null));
  });

  it("accepts only linked/ignored and numeric Canvas ids (as text, beyond JS safe integers)", async () => {
    await rejects(as(db, "authenticated", USER_A, link("2", "unmapped", null)), /canvas_course_links_state_(valid|project)/);
    for (const bad of ["", "12a", "TALLER", "1".repeat(21), " 12"]) {
      await rejects(as(db, "authenticated", USER_A, link(bad, "ignored", null)), /canvas_course_links_course_id_format/);
    }
    const [row] = await as(db, "authenticated", USER_A, link("90071992547409930", "ignored", null));
    assert.equal(row.canvas_course_id, "90071992547409930");
  });

  it("allows one decision per course and user", async () => {
    await rejects(as(db, "authenticated", USER_A, link("145580", "ignored", null)), /canvas_course_links_user_course_key/);
    // The same course id for another user is a separate decision.
    await as(db, "authenticated", USER_B, link("145580", "ignored", null));
  });

  it("lets several Canvas courses point to the same project", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `insert into public.canvas_course_links (canvas_course_id, project_id, state) values ('145581', '${projectA}', 'linked');
       select count(*)::int as n from public.canvas_course_links where project_id = '${projectA}'`,
    );
    assert.deepEqual(rows, [{ n: 2 }]);
  });

  it("rejects blank snapshot metadata", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.canvas_course_links (canvas_course_id, state, canvas_course_name) values ('3', 'ignored', ' ')`),
      /canvas_course_links_name_length/,
    );
  });
});

describe("canvas_course_links: privileges and RLS", () => {
  it("denies all access to anon", async () => {
    await rejects(as(db, "anon", null, `select * from public.canvas_course_links`), /permission denied/);
    await rejects(as(db, "anon", null, link("9", "ignored", null)), /permission denied/);
    await rejects(as(db, "anon", null, `delete from public.canvas_course_links`), /permission denied/);
  });

  it("shows each user only their own decisions", async () => {
    assert.equal((await as(db, "authenticated", USER_B, `select id from public.canvas_course_links`)).length, 0);
    assert.equal((await as(db, "authenticated", USER_A, `select id from public.canvas_course_links`)).length, 1);
  });

  it("does not let B change or delete A's link (0 rows)", async () => {
    assert.equal((await as(db, "authenticated", USER_B, `update public.canvas_course_links set state = 'ignored', project_id = null returning id`)).length, 0);
    assert.equal((await as(db, "authenticated", USER_B, `delete from public.canvas_course_links returning id`)).length, 0);
  });

  it("does not let clients write the owner, id, course id or timestamps on update", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.canvas_course_links (user_id, canvas_course_id, state) values ('${USER_B}', '5', 'ignored')`),
      /permission denied/,
    );
    for (const column of [`user_id = '${USER_B}'`, `id = gen_random_uuid()`, `canvas_course_id = '999'`, `created_at = now()`, `updated_at = now()`]) {
      await rejects(as(db, "authenticated", USER_A, `update public.canvas_course_links set ${column} where canvas_course_id = '145580'`), /permission denied/);
    }
  });

  it("lets the owner change the project, ignore and unlink (delete the row)", async () => {
    const [changed] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.canvas_course_links set project_id = '${project2A}', canvas_course_name = 'Renombrado'
       where canvas_course_id = '145580' returning project_id, canvas_course_name`,
    );
    assert.deepEqual(changed, { project_id: project2A, canvas_course_name: "Renombrado" });
    const [ignored] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.canvas_course_links set state = 'ignored', project_id = null where canvas_course_id = '145580' returning state`,
    );
    assert.equal(ignored.state, "ignored");
    assert.equal((await as(db, "authenticated", USER_A, `delete from public.canvas_course_links where canvas_course_id = '145580' returning id`)).length, 1);
  });
});

describe("canvas_course_links -> projects", () => {
  it("rejects linking to another user's project (insert and update)", async () => {
    await rejects(as(db, "authenticated", USER_A, link("7", "linked", projectB)), /canvas_course_links_project_owner_fkey/);
    await rejects(
      as(db, "authenticated", USER_A, `update public.canvas_course_links set project_id = '${projectB}' where canvas_course_id = '145580'`),
      /canvas_course_links_project_owner_fkey/,
    );
    await rejects(
      db.exec(`insert into public.canvas_course_links (user_id, canvas_course_id, project_id, state) values ('${USER_B}', '7', '${projectA}', 'linked')`),
      /canvas_course_links_project_owner_fkey/,
    );
  });

  it("deleting a project removes its links (the course becomes unmapped) and nothing else", async () => {
    const rows = await as<{ links: number; ignored: number; projects: number }>(
      db,
      "authenticated",
      USER_A,
      `insert into public.canvas_course_links (canvas_course_id, state) values ('8', 'ignored');
       delete from public.projects where id = '${projectA}';
       select (select count(*)::int from public.canvas_course_links where canvas_course_id = '145580') as links,
              (select count(*)::int from public.canvas_course_links where canvas_course_id = '8') as ignored,
              (select count(*)::int from public.projects) as projects`,
    );
    assert.deepEqual(rows, [{ links: 0, ignored: 1, projects: 1 }]);
  });
});

const createFromCourse = (courseId: string, name: string, status = "active") =>
  `select public.create_project_from_canvas_course(p_canvas_course_id => '${courseId}', p_name => '${name}',
     p_canvas_course_name => 'CURSO ${courseId}', p_canvas_course_code => 'C-${courseId}', p_status => '${status}') as id`;

describe("create_project_from_canvas_course", () => {
  it("creates the project and the link together, as the caller", async () => {
    const rows = await as<{ name: string; user_id: string; source: string; state: string; course_name: string }>(
      db,
      "authenticated",
      USER_A,
      `select public.create_project_from_canvas_course(p_canvas_course_id => '200', p_name => 'Taller de Dibujo',
         p_canvas_course_name => 'TALLER DE DIBUJO (M21)', p_canvas_course_code => 'TD', p_area => 'Arquitectura');
       select p.name, p.user_id, p.source, l.state, l.canvas_course_name as course_name
         from public.canvas_course_links l join public.projects p on p.id = l.project_id
        where l.canvas_course_id = '200'`,
    );
    assert.deepEqual(rows, [{ name: "Taller de Dibujo", user_id: USER_A, source: "manual", state: "linked", course_name: "TALLER DE DIBUJO (M21)" }]);
  });

  it("replaces an existing ignored decision for the same course", async () => {
    const [row] = await as<{ state: string; has_project: boolean }>(
      db,
      "authenticated",
      USER_A,
      `insert into public.canvas_course_links (canvas_course_id, state) values ('300', 'ignored');
       ${createFromCourse("300", "Nuevo")};
       select state, project_id is not null as has_project from public.canvas_course_links where canvas_course_id = '300'`,
    );
    assert.deepEqual(row, { state: "linked", has_project: true });
  });

  it("is atomic: an invalid link leaves no project behind", async () => {
    const rows = await as<{ n: number }>(
      db,
      "authenticated",
      USER_A,
      `savepoint s;
       do $$ begin
         perform public.create_project_from_canvas_course(p_canvas_course_id => 'not-a-number', p_name => 'Huérfano');
       exception when check_violation then null;
       end $$;
       select count(*)::int as n from public.projects where name = 'Huérfano'`,
    );
    assert.deepEqual(rows, [{ n: 0 }]);
    await rejects(as(db, "authenticated", USER_A, createFromCourse("400", "   ")), /projects_name_length/);
    const after = await as<{ n: number }>(db, "authenticated", USER_A, `select count(*)::int as n from public.canvas_course_links where canvas_course_id = '400'`);
    assert.deepEqual(after, [{ n: 0 }]);
  });

  it("cannot be used by anon, and cannot act for another user", async () => {
    await rejects(as(db, "anon", null, createFromCourse("500", "x")), /permission denied/);
    // B's call creates B's rows only: RLS + defaults, never A's.
    const rows = await as<{ owner: string }>(
      db,
      "authenticated",
      USER_B,
      `${createFromCourse("500", "De B")};
       select user_id as owner from public.canvas_course_links where canvas_course_id = '500'`,
    );
    assert.deepEqual(rows, [{ owner: USER_B }]);
  });

  it("runs as SECURITY INVOKER with a fixed search_path", async () => {
    const [fn] = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      `select prosecdef, proconfig from pg_proc where proname = 'create_project_from_canvas_course'`,
    ).then((r) => r.rows);
    assert.equal(fn.prosecdef, false);
    assert.deepEqual(fn.proconfig, ['search_path=""']);
  });
});
