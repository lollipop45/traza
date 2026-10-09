// Release gate (v1.0): a schema-wide security audit of the database the migrations produce. Where the
// other suites test each feature's behaviour, this one fails if ANY table, policy, grant, foreign key
// or function drifts from TRAZA's rules, including ones added by a future migration.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createDatabase } from "./harness";

let db: PGlite;
before(async () => {
  db = await createDatabase();
});
after(async () => {
  await db.close();
});

const rows = async <T>(sql: string) => (await db.query<T>(sql)).rows;

/** Every per-user table TRAZA has. A new table must be added here on purpose (and audited). */
const USER_TABLES = [
  "assistant_actions",
  "assistant_conversations",
  "assistant_messages",
  "calendar_events",
  "canvas_assignment_preferences",
  "canvas_course_links",
  "canvas_sync_state",
  "google_calendar_connections",
  "google_calendar_item_links",
  "google_calendar_sync_state",
  "inbox_items",
  "notification_deliveries",
  "notification_preferences",
  "projects",
  "push_subscriptions",
  "tasks",
];

describe("security audit: tables", () => {
  it("the public schema holds exactly the known per-user tables, each with a user_id and RLS on", async () => {
    const tables = await rows<{ relname: string; rls: boolean; has_user: boolean }>(`
      select c.relname, c.relrowsecurity as rls,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) as has_user
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`);
    assert.deepEqual(tables.map((t) => t.relname), USER_TABLES);
    for (const t of tables) {
      assert.equal(t.rls, true, `${t.relname}: RLS enabled`);
      assert.equal(t.has_user, true, `${t.relname}: owned by a user`);
    }
  });

  it("no view, materialized view or foreign table bypasses RLS in public", async () => {
    const other = await rows<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('v', 'm', 'f')`);
    assert.deepEqual(other, []);
  });

  it("anon has no privilege on any public table", async () => {
    for (const table of USER_TABLES) {
      const [p] = await rows<Record<string, boolean>>(`
        select has_table_privilege('anon', 'public.${table}', 'select') as s, has_table_privilege('anon', 'public.${table}', 'insert') as i,
               has_table_privilege('anon', 'public.${table}', 'update') as u, has_table_privilege('anon', 'public.${table}', 'delete') as d,
               has_table_privilege('anon', 'public.${table}', 'truncate') as t, has_table_privilege('anon', 'public.${table}', 'references') as r,
               has_table_privilege('anon', 'public.${table}', 'trigger') as g`);
      assert.deepEqual(Object.values(p), [false, false, false, false, false, false, false], table);
    }
  });

  it("authenticated can never truncate, and never write user_id after insert", async () => {
    for (const table of USER_TABLES) {
      const [p] = await rows<{ t: boolean; u: boolean }>(`
        select has_table_privilege('authenticated', 'public.${table}', 'truncate') as t,
               has_column_privilege('authenticated', 'public.${table}', 'user_id', 'update') as u`);
      assert.equal(p.t, false, `${table}: truncate`);
      assert.equal(p.u, false, `${table}: user_id is not updatable`);
    }
  });
});

describe("security audit: policies", () => {
  it("every policy applies to authenticated only and is tied to the caller's identity", async () => {
    const policies = await rows<{ tablename: string; policyname: string; roles: string; permissive: string; qual: string | null; with_check: string | null }>(`
      select tablename, policyname, roles::text as roles, permissive, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`);
    assert.ok(policies.length >= USER_TABLES.length, "every table has policies");
    const covered = new Set(policies.map((p) => p.tablename));
    for (const table of USER_TABLES) assert.ok(covered.has(table), `${table} has at least one policy`);
    for (const p of policies) {
      const name = `${p.tablename}.${p.policyname}`;
      assert.equal(p.roles, "{authenticated}", `${name}: roles`);
      assert.equal(p.permissive, "PERMISSIVE", name);
      for (const expression of [p.qual, p.with_check]) {
        if (expression === null) continue;
        assert.notEqual(expression.trim(), "true", `${name}: always-true expression`);
        assert.match(expression, /auth\.uid\(\)/, `${name}: depends on auth.uid()`);
        assert.match(expression, /user_id/, `${name}: compares the owner`);
      }
    }
  });
});

describe("security audit: foreign keys", () => {
  it("every reference between two user-owned tables includes user_id (no cross-user links)", async () => {
    const keys = await rows<{ conname: string; source: string; target: string; columns: string[] }>(`
      select con.conname, src.relname as source, dst.relname as target,
             array(select a.attname::text from unnest(con.conkey) k join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k order by 1) as columns
        from pg_constraint con
        join pg_class src on src.oid = con.conrelid join pg_namespace sn on sn.oid = src.relnamespace
        join pg_class dst on dst.oid = con.confrelid join pg_namespace dn on dn.oid = dst.relnamespace
       where con.contype = 'f' and sn.nspname = 'public' and dn.nspname = 'public' order by 1`);
    assert.ok(keys.length > 0);
    for (const key of keys) assert.ok(key.columns.includes("user_id"), `${key.conname} (${key.source} → ${key.target}): ${key.columns.join(", ")}`);
  });

  it("every table's user_id references auth.users", async () => {
    for (const table of USER_TABLES) {
      const [{ ok }] = await rows<{ ok: boolean }>(`
        select exists (
          select 1 from pg_constraint con join pg_class dst on dst.oid = con.confrelid join pg_namespace dn on dn.oid = dst.relnamespace
           where con.contype = 'f' and con.conrelid = 'public.${table}'::regclass and dn.nspname = 'auth' and dst.relname = 'users'
             and con.conkey = array[(select attnum from pg_attribute where attrelid = 'public.${table}'::regclass and attname = 'user_id')]
        ) as ok`);
      assert.equal(ok, true, table);
    }
  });
});

describe("security audit: functions", () => {
  type Fn = { schema: string; name: string; args: string; definer: boolean; config: string[] | null; anon: boolean; authenticated: boolean; service: boolean; public_exec: boolean };
  let functions: Fn[] = [];
  before(async () => {
    functions = await rows<Fn>(`
      select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'traza_private') and p.prokind = 'f' order by 1`);
  });

  it("no function is executable by anon or by PUBLIC", () => {
    assert.ok(functions.length > 0);
    for (const f of functions) {
      assert.equal(f.anon, false, `${f.name}: anon`);
      assert.equal(f.public_exec, false, `${f.name}: PUBLIC`);
    }
  });

  it("every function (SECURITY DEFINER or not) pins an empty search_path", () => {
    assert.ok(functions.some((fn) => fn.definer));
    for (const f of functions) assert.deepEqual(f.config, ['search_path=""'], `${f.schema}.${f.name}`);
  });

  it("only scheduler_* functions take a user id, and only service_role can run them", () => {
    // (traza_private.scheduler_target is their internal helper: nobody may call it directly.)
    for (const f of functions.filter((fn) => fn.schema === "public")) {
      const takesUser = /\bp_user_id\b/.test(f.args);
      const scheduler = f.name.startsWith("scheduler_");
      if (scheduler) {
        assert.ok(takesUser, `${f.name} takes p_user_id`);
        assert.equal(f.authenticated, false, `${f.name}: never a browser`);
        assert.equal(f.service, true, `${f.name}: service_role`);
      } else if (takesUser) {
        assert.fail(`${f.name}: a non-scheduler function must not accept a user id (${f.args})`);
      }
    }
    assert.equal(functions.filter((f) => f.schema === "public" && f.name.startsWith("scheduler_")).length, 9);
  });

  it("nothing in traza_private is callable by a client", () => {
    const internal = functions.filter((f) => f.schema === "traza_private");
    assert.ok(internal.length > 0);
    for (const f of internal) assert.deepEqual([f.anon, f.authenticated], [false, false], f.name);
  });
});
