// Database-level guarantees of the assistant (20261006141207): owner-only conversations, messages
// and proposals; atomic replies; and execute_assistant_action() as the single, idempotent,
// confirmation-only path that creates source = 'ai' records.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;

const CONV_A = "aaaaaaaa-0000-4000-8000-0000000000c1";
const CONV_B = "bbbbbbbb-0000-4000-8000-0000000000c1";
const PROJECT_A = "aaaaaaaa-0000-4000-8000-0000000000f1";
const PROJECT_B = "bbbbbbbb-0000-4000-8000-0000000000f1";

const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
const task = (payload: Record<string, unknown> = {}) => ({ action_type: "create_task", payload: { title: "Imprimir A1", due_date: "2026-10-07", priority: "normal", project_id: PROJECT_A, ...payload } });
const reply = (conversation: string, actions: unknown[]) => `select public.add_assistant_reply('${conversation}', 'Te propongo esto.', ${json(actions)}) as message_id`;
/** The id of the caller's first proposal (after a reply in the same transaction). */
const firstAction = `(select id from public.assistant_actions order by created_at, position limit 1)`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

before(async () => {
  db = await createDatabase();
  // Fixture ids chosen for readability (as the table owner; clients never send ids).
  await db.exec(`
    insert into public.projects (id, user_id, name) values ('${PROJECT_A}', '${USER_A}', 'Taller'), ('${PROJECT_B}', '${USER_B}', 'Otro');
    insert into public.assistant_conversations (id, user_id, title) values ('${CONV_A}', '${USER_A}', 'Hola'), ('${CONV_B}', '${USER_B}', 'Hola B');
  `);
  await commitAs(db, "authenticated", USER_B, `insert into public.assistant_messages (conversation_id, role, content) values ('${CONV_B}', 'user', 'Mensaje privado de B'); ${reply(CONV_B, [task({ project_id: PROJECT_B })])}`);
});

describe("assistant history: ownership", () => {
  it("shows each user only their own conversations, messages and proposals", async () => {
    for (const table of ["assistant_conversations", "assistant_messages", "assistant_actions"]) {
      const rows = await as<{ user_id: string }>(db, "authenticated", USER_A, `select user_id from public.${table}`);
      assert.ok(rows.every((row) => row.user_id === USER_A), table);
    }
    const rows = await as(db, "authenticated", USER_A, `select content from public.assistant_messages`);
    assert.ok(!rows.some((row) => row.content === "Mensaje privado de B"));
  });

  it("denies anon everything", async () => {
    for (const table of ["assistant_conversations", "assistant_messages", "assistant_actions"]) {
      await rejects(as(db, "anon", null, `select id from public.${table}`), /permission denied/);
    }
    for (const fn of [`add_assistant_reply('${CONV_A}', 'x', '[]')`, `execute_assistant_action('${CONV_A}')`, `dismiss_assistant_action('${CONV_A}')`]) {
      await rejects(as(db, "anon", null, `select * from public.${fn}`), /permission denied/);
    }
  });

  it("cannot write into another user's conversation, even knowing its id", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.assistant_messages (conversation_id, role, content) values ('${CONV_B}', 'user', 'intrusión')`),
      /conversation_owner_fkey/,
    );
    await rejects(as(db, "authenticated", USER_A, reply(CONV_B, [])), /conversation_owner_fkey/);
    const [{ message_id }] = await as<{ message_id: string }>(db, "authenticated", USER_B, `select id as message_id from public.assistant_messages where role = 'assistant'`);
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.assistant_actions (message_id, position, action_type, payload) values ('${message_id}', 1, 'create_task', '{}')`),
      /message_owner_fkey/,
    );
  });

  it("never lets a client choose the owner or a proposal's state or result", async () => {
    await rejects(as(db, "authenticated", USER_A, `insert into public.assistant_conversations (user_id, title) values ('${USER_B}', 'x')`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `insert into public.assistant_messages (user_id, conversation_id, role, content) values ('${USER_B}', '${CONV_A}', 'user', 'x')`), /permission denied/);
    await rejects(
      as(db, "authenticated", USER_A, `${reply(CONV_A, [task()])}; update public.assistant_actions set state = 'executed', executed_at = now()`),
      /permission denied/,
    );
    await rejects(as(db, "authenticated", USER_A, `${reply(CONV_A, [task()])}; delete from public.assistant_actions`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `${reply(CONV_A, [])}; update public.assistant_messages set content = 'cambiado'`), /permission denied/);
  });

  it("validates roles, lengths and proposal types", async () => {
    await rejects(as(db, "authenticated", USER_A, `insert into public.assistant_messages (conversation_id, role, content) values ('${CONV_A}', 'system', 'x')`), /role_valid/);
    await rejects(as(db, "authenticated", USER_A, `insert into public.assistant_messages (conversation_id, role, content) values ('${CONV_A}', 'user', '   ')`), /content_length/);
    await rejects(as(db, "authenticated", USER_A, reply(CONV_A, [{ action_type: "delete_task", payload: {} }])), /type_valid/);
    await rejects(as(db, "authenticated", USER_A, reply(CONV_A, [{ action_type: "create_task", payload: [] }])), /payload_object/);
  });

  it("stores a reply and its proposals atomically (one bad proposal stores nothing)", async () => {
    const counts = `select (select count(*)::int from public.assistant_messages) as messages, (select count(*)::int from public.assistant_actions) as actions`;
    const [before] = await as(db, "authenticated", USER_A, counts);
    await rejects(as(db, "authenticated", USER_A, reply(CONV_A, [task(), { action_type: "nope", payload: {} }])), /type_valid/);
    const [after] = await as(db, "authenticated", USER_A, counts);
    assert.deepEqual(after, before);
    const [ok] = await as(db, "authenticated", USER_A, `${reply(CONV_A, [task(), task({ title: "Otra" })])}; ${counts}`);
    assert.deepEqual(ok, { messages: (before.messages as number) + 1, actions: (before.actions as number) + 2 });
  });

  it("bumps the conversation when a message is added; deleting it removes its history", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `update public.assistant_conversations set title = 'x' where false;
       select updated_at as before from public.assistant_conversations where id = '${CONV_A}';`,
    );
    const later = await as(
      db,
      "authenticated",
      USER_A,
      `select pg_sleep(0.01); insert into public.assistant_messages (conversation_id, role, content) values ('${CONV_A}', 'user', 'Hola');
       select updated_at from public.assistant_conversations where id = '${CONV_A}'`,
    );
    assert.ok(new Date(later[0].updated_at as string) >= new Date(rows[0].before as string));
    const gone = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task()])}; delete from public.assistant_conversations where id = '${CONV_A}';
       select (select count(*)::int from public.assistant_messages) as m, (select count(*)::int from public.assistant_actions) as a`,
    );
    assert.deepEqual(gone, [{ m: 0, a: 0 }]);
  });
});

describe("execute_assistant_action", () => {
  it("does nothing before confirmation; confirming creates exactly one ai task", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task()])};
       select (select count(*)::int from public.tasks) as before_confirm;`,
    );
    assert.deepEqual(rows, [{ before_confirm: 0 }]);
    const done = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task()])};
       select * from public.execute_assistant_action(${firstAction});
       select t.title, t.source, t.status, t.due_date::text, t.project_id, t.user_id, a.state, a.result_task_id = t.id as linked
         from public.tasks t join public.assistant_actions a on a.result_task_id = t.id`,
    );
    assert.deepEqual(done, [{ title: "Imprimir A1", source: "ai", status: "pending", due_date: "2026-10-07", project_id: PROJECT_A, user_id: USER_A, state: "executed", linked: true }]);
  });

  it("is idempotent: confirming again (double click, refresh) creates no duplicate", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task()])};
       create temp table outcomes on commit drop as select * from public.execute_assistant_action(${firstAction});
       insert into outcomes select * from public.execute_assistant_action(${firstAction});
       insert into outcomes select * from public.execute_assistant_action(${firstAction});
       select (select array_agg(outcome order by outcome) from outcomes) as outcomes,
              (select count(distinct item_id)::int from outcomes) as items,
              (select count(*)::int from public.tasks) as tasks`,
    );
    assert.deepEqual(rows, [{ outcomes: ["already-executed", "already-executed", "executed"], items: 1, tasks: 1 }]);
  });

  it("creates events and notes/ideas with source ai and the kind from the action type", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [
        { action_type: "create_event", payload: { title: "Corrección", event_date: "2026-10-08", start_time: "10:00", end_time: "12:00", all_day: false, location: "Aula", project_id: PROJECT_A } },
        { action_type: "create_idea", payload: { title: "Lamas", content: "De madera", project_id: null, kind: "note" } },
      ])};
       select * from public.execute_assistant_action((select id from public.assistant_actions where position = 1));
       select * from public.execute_assistant_action((select id from public.assistant_actions where position = 2));
       select (select row(title, start_time::text, source)::text from public.calendar_events) as event,
              (select row(kind, title, content, source)::text from public.inbox_items) as idea`,
    );
    assert.deepEqual(rows, [{ event: "(Corrección,10:00:00,ai)", idea: "(idea,Lamas,\"De madera\",ai)" }]);
  });

  it("refuses dismissed proposals; executed ones cannot be dismissed", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `${reply(CONV_A, [task()])}; select public.dismiss_assistant_action(${firstAction}); select * from public.execute_assistant_action(${firstAction})`),
      /dismissed/,
    );
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task()])}; select * from public.execute_assistant_action(${firstAction});
       select public.dismiss_assistant_action(${firstAction}) as state, (select count(*)::int from public.tasks) as tasks`,
    );
    assert.deepEqual(rows, [{ state: "executed", tasks: 1 }]);
  });

  it("user A cannot execute or dismiss user B's proposal", async () => {
    const [{ id }] = await as<{ id: string }>(db, "authenticated", USER_B, `select id from public.assistant_actions`);
    await rejects(as(db, "authenticated", USER_A, `select * from public.execute_assistant_action('${id}')`), /not found/);
    await rejects(as(db, "authenticated", USER_A, `select public.dismiss_assistant_action('${id}')`), /not found/);
    const [row] = await as(db, "authenticated", USER_B, `select state from public.assistant_actions where id = '${id}'`);
    assert.equal(row.state, "proposed");
  });

  it("refuses a project of another user (owner-matching keys) and keeps the proposal proposed", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `${reply(CONV_A, [task({ project_id: PROJECT_B })])}; select * from public.execute_assistant_action(${firstAction})`),
      /project_owner_fkey/,
    );
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task({ project_id: PROJECT_B })])};
       do $$ begin perform public.execute_assistant_action((select id from public.assistant_actions limit 1)); exception when others then null; end $$;
       select (select state from public.assistant_actions) as state, (select count(*)::int from public.tasks) as tasks`,
    );
    assert.deepEqual(rows, [{ state: "proposed", tasks: 0 }]);
  });

  it("re-validates the payload: impossible dates, bad times, wrong types, unknown fields ignored", async () => {
    for (const [payload, pattern] of [
      [task({ due_date: "2026-02-30" }).payload, /out of range|Invalid/],
      [task({ due_date: "mañana" }).payload, /Invalid due_date/],
      [task({ due_date: "1999-01-01" }).payload, /Invalid due_date/],
      [task({ title: 42 }).payload, /Invalid title/],
      [task({ title: "   " }).payload, /title_not_blank|null value/],
      [task({ priority: "urgent" }).payload, /priority_valid/],
      [task({ project_id: "P1" }).payload, /invalid input syntax for type uuid/],
    ] as const) {
      await rejects(as(db, "authenticated", USER_A, `${reply(CONV_A, [{ action_type: "create_task", payload }])}; select * from public.execute_assistant_action(${firstAction})`), pattern);
    }
    await rejects(
      as(
        db,
        "authenticated",
        USER_A,
        `${reply(CONV_A, [{ action_type: "create_event", payload: { title: "E", event_date: "2026-10-08", start_time: "25:00", all_day: false } }])}; select * from public.execute_assistant_action(${firstAction})`,
      ),
      /Invalid start_time/,
    );
    await rejects(
      as(
        db,
        "authenticated",
        USER_A,
        `${reply(CONV_A, [{ action_type: "create_event", payload: { title: "E", event_date: "2026-10-08", start_time: "12:00", end_time: "10:00", all_day: false } }])}; select * from public.execute_assistant_action(${firstAction})`,
      ),
      /times_consistent/,
    );
    // user_id / source / id in the payload are never read: the record is the caller's, source ai.
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task({ user_id: USER_B, source: "manual", id: PROJECT_B, status: "done" })])};
       select * from public.execute_assistant_action(${firstAction});
       select user_id, source, status from public.tasks`,
    );
    assert.deepEqual(rows, [{ user_id: USER_A, source: "ai", status: "pending" }]);
  });

  it("requires a user, takes no user id, and is SECURITY DEFINER with an empty search_path", async () => {
    await rejects(as(db, "authenticated", null, `select * from public.execute_assistant_action('${CONV_A}')`), /Not authenticated/);
    await rejects(as(db, "authenticated", USER_A, `select * from public.execute_assistant_action('${CONV_A}', '${USER_B}')`), /does not exist/);
    const fns = await db
      .query<{ proname: string; prosecdef: boolean; proconfig: string[]; anon: boolean; auth: boolean }>(
        `select proname, prosecdef, proconfig, has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as auth
           from pg_proc where proname in ('execute_assistant_action', 'dismiss_assistant_action', 'add_assistant_reply', 'assistant_payload_text', 'assistant_payload_date', 'assistant_payload_time')
          order by proname`,
      )
      .then((r) => r.rows);
    assert.deepEqual(
      fns.map(({ proname, prosecdef, proconfig, anon, auth }) => [proname, prosecdef, proconfig, anon, auth]),
      [
        ["add_assistant_reply", false, ['search_path=""'], false, true],
        ["assistant_payload_date", false, ['search_path=""'], false, false],
        ["assistant_payload_text", false, ['search_path=""'], false, false],
        ["assistant_payload_time", false, ['search_path=""'], false, false],
        ["dismiss_assistant_action", true, ['search_path=""'], false, true],
        ["execute_assistant_action", true, ['search_path=""'], false, true],
      ],
    );
  });

  it("keeps the proposal executed if the created record is later deleted (never re-created)", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `${reply(CONV_A, [task()])}; select * from public.execute_assistant_action(${firstAction});
       delete from public.tasks;
       select * from public.execute_assistant_action(${firstAction});
       select (select state from public.assistant_actions) as state, (select count(*)::int from public.tasks) as tasks`,
    );
    assert.deepEqual(rows, [{ state: "executed", tasks: 0 }]);
  });

  it("leaves ordinary client privileges unchanged: source stays unwritable", async () => {
    await rejects(as(db, "authenticated", USER_A, `insert into public.tasks (title, source) values ('x', 'ai')`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `insert into public.calendar_events (title, event_date, all_day, source) values ('x', '2026-10-08', true, 'ai')`), /permission denied/);
    await rejects(as(db, "authenticated", USER_A, `insert into public.inbox_items (kind, title, source) values ('note', 'x', 'ai')`), /permission denied/);
  });
});
