import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { as, createDatabase, USER_A } from "./harness";

// The scheduler wake-up migration (pg_cron + pg_net + Vault). On PGlite those extensions are the
// harness's stand-ins: Vault's decrypted_secrets reads a plain table, net.http_post records the
// request instead of sending it, cron.schedule upserts by name. No network, no real secret.

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const FILE = readdirSync(MIGRATIONS).find((file) => file.endsWith("_scheduler_cron.sql"));
const URL = "https://traza-example.vercel.app/api/internal/scheduler";
const SECRET = "fake-scheduler-secret-for-tests-0123456789";

let db: PGlite;

/** As the database owner (like the cron job), in a rolled-back transaction. */
async function asOwner<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return db.transaction(async (tx) => {
    const results = await tx.exec(sql);
    await tx.rollback();
    return (results.at(-1)?.rows ?? []) as T[];
  });
}

const secrets = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `insert into vault.stub_secrets values ('${name}', '${value.replace(/'/g, "''")}');`)
    .join("\n");

const invoke = (setup: string) => asOwner<{ id: string | null; requests: number }>(`${setup} select traza_private.invoke_scheduler()::text as id, (select count(*)::int from net.stub_requests) as requests;`);

before(async () => {
  db = await createDatabase();
});

describe("scheduler migration: source", () => {
  it("exists, and stores no URL, secret, key or token", () => {
    assert.ok(FILE);
    const sql = readFileSync(join(MIGRATIONS, FILE!), "utf8").replace(/--.*$/gm, "");
    assert.doesNotMatch(sql, /sb_secret_|sb_publishable_|eyJhbGci|vercel\.app|https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    assert.doesNotMatch(sql, /vault\.create_secret|vault\.update_secret|insert into vault/i);
    // Reads exactly the two fixed Vault names, nothing else.
    const names = [...sql.matchAll(/s\.name = '([a-z_]+)'/g)].map((match) => match[1]);
    assert.deepEqual(names, ["traza_scheduler_url", "traza_scheduler_secret"]);
  });

  it("does not touch any table, policy or client grant", () => {
    const sql = readFileSync(join(MIGRATIONS, FILE!), "utf8").replace(/--.*$/gm, "");
    assert.doesNotMatch(sql, /\b(create|alter|drop) table\b|\bpolicy\b|row level security|grant [^;]* to (anon|authenticated)/i);
  });
});

describe("scheduler migration: wake-up function", () => {
  it("exists in the private schema, takes no arguments, and the jobs are scheduled every 5 minutes / nightly cleanup", async () => {
    const fn = await asOwner<{ args: string; definer: boolean; schema: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as definer, n.nspname as schema
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'invoke_scheduler'`,
    );
    assert.deepEqual(fn, [{ args: "", definer: false, schema: "traza_private" }]);
    const jobs = await asOwner<{ jobname: string; schedule: string; command: string }>("select jobname, schedule, command from cron.job order by jobname");
    assert.deepEqual(
      jobs.map((job) => [job.jobname, job.schedule]),
      [
        ["traza-scheduler", "*/5 * * * *"],
        ["traza-scheduler-cleanup", "17 3 * * *"],
      ],
    );
    assert.equal(jobs[0].command, "select traza_private.invoke_scheduler()");
    assert.match(jobs[1].command, /delete from cron\.job_run_details/);
    assert.match(jobs[1].command, /jobname in \('traza-scheduler', 'traza-scheduler-cleanup'\)/, "cleans only its own history");
  });

  it("is a quiet no-op until BOTH Vault secrets exist", async () => {
    for (const setup of ["", secrets({ traza_scheduler_url: URL }), secrets({ traza_scheduler_secret: SECRET })]) {
      assert.deepEqual(await invoke(setup), [{ id: null, requests: 0 }], setup || "(none)");
    }
  });

  it("with both, POSTs once to that URL with the bearer secret, JSON, a fixed body and a long timeout", async () => {
    const rows = await asOwner<{ url: string; body: unknown; headers: Record<string, string>; timeout_milliseconds: number }>(
      `${secrets({ traza_scheduler_url: URL, traza_scheduler_secret: SECRET })}
       select traza_private.invoke_scheduler();
       select url, body, headers, timeout_milliseconds from net.stub_requests;`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, URL);
    assert.deepEqual(rows[0].headers, { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` });
    assert.deepEqual(rows[0].body, { source: "supabase-cron", version: 1 }, "no user id, no data");
    assert.ok(rows[0].timeout_milliseconds >= 60_000 && rows[0].timeout_milliseconds < 300_000);
  });

  it("refuses a target that is not https or not the scheduler path, and a weak secret (nothing is sent)", async () => {
    for (const url of [
      "http://traza-example.vercel.app/api/internal/scheduler",
      "https://traza-example.vercel.app/api/other",
      "https://traza-example.vercel.app/api/internal/scheduler?x=1",
      "https://user:pass@traza-example.vercel.app/api/internal/scheduler",
      "https://traza-example.vercel.app/api/internal/scheduler/../../x",
      "ftp://traza-example.vercel.app/api/internal/scheduler",
    ]) {
      assert.deepEqual(await invoke(secrets({ traza_scheduler_url: url, traza_scheduler_secret: SECRET })), [{ id: null, requests: 0 }], url);
    }
    for (const secret of ["short", "x".repeat(31), `${"x".repeat(40)} space`]) {
      assert.deepEqual(await invoke(secrets({ traza_scheduler_url: URL, traza_scheduler_secret: secret })), [{ id: null, requests: 0 }], secret);
    }
  });

  it("reads only the two fixed names: similarly named or other secrets are ignored", async () => {
    const rows = await invoke(secrets({ traza_scheduler_url_backup: URL, traza_scheduler_secret_old: SECRET, other_secret: SECRET }));
    assert.deepEqual(rows, [{ id: null, requests: 0 }]);
  });
});

describe("scheduler migration: nobody else can use it", () => {
  for (const role of ["anon", "authenticated"] as const) {
    it(`${role} cannot run the wake-up, read Vault, or see/schedule cron jobs`, async () => {
      for (const sql of [
        "select traza_private.invoke_scheduler()",
        "select * from vault.decrypted_secrets",
        "select * from cron.job",
        "select cron.schedule('x', '* * * * *', 'select 1')",
        "select net.http_post('https://example.com')",
      ]) {
        await assert.rejects(as(db, role, role === "authenticated" ? USER_A : null, sql), /permission denied/, `${role}: ${sql}`);
      }
    });
  }

  it("service_role (the app's secret key through the Data API) cannot run it either", async () => {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec("set local role service_role;");
        await tx.exec("select traza_private.invoke_scheduler()");
      }),
      /permission denied/,
    );
  });

  it("existing RLS is unchanged: every public table still has row level security", async () => {
    const tables = await asOwner<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    assert.ok(tables.length >= 10);
    for (const table of tables) assert.equal(table.rls, true, table.relname);
  });
});
