// Runs the real migrations against an in-process Postgres (PGlite) with the minimum of Supabase it
// needs: the anon / authenticated / service_role roles, auth.users and auth.uid() read from the
// request JWT claim, like PostgREST sets it. No network, no credentials, no production data.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

export const USER_A = "00000000-0000-4000-8000-00000000000a";
export const USER_B = "00000000-0000-4000-8000-00000000000b";

export type Role = "anon" | "authenticated";

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    -- Emulate the legacy default that auto-exposes new public tables: migrations must not rely on it.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    insert into auth.users values ('${USER_A}'), ('${USER_B}');
  `);

  await db.exec(SUPABASE_EXTENSION_STUBS);

  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(withoutSupabaseOnlyExtensions(readFileSync(join(MIGRATIONS_DIR, file), "utf8")));
  return db;
}

/**
 * pg_cron, pg_net and Vault exist only on Supabase. The harness replaces them with minimal stand-ins
 * of the parts the scheduler migration uses: Vault's decrypted_secrets view (fed by a plain table),
 * net.http_post (records the request instead of sending it) and cron.schedule (upserts by name).
 * Like on Supabase, client roles get no access to these schemas.
 */
const SUPABASE_EXTENSION_STUBS = `
  create schema extensions;
  create schema vault;
  create table vault.stub_secrets (name text primary key, decrypted_secret text not null);
  create view vault.decrypted_secrets as select name, decrypted_secret from vault.stub_secrets;
  create schema net;
  create table net.stub_requests (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
  create function net.http_post(
    url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
    headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000
  ) returns bigint language sql as $$
    insert into net.stub_requests (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id
  $$;
  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null);
  create table cron.job_run_details (jobid bigint, end_time timestamptz);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
    returning jobid
  $$;
`;

/** The "create extension" lines for the stubbed Supabase extensions (everything else runs as is). */
export function withoutSupabaseOnlyExtensions(sql: string): string {
  return sql.replace(/^create extension if not exists (pg_cron|pg_net|supabase_vault)\b[^;]*;/gim, "-- (test harness: stubbed) $&");
}

/**
 * Runs `sql` as a Data API role inside a transaction that is always rolled back, so each check
 * starts from the same data. Returns the rows of the last statement.
 */
export async function as<T = Record<string, unknown>>(
  db: PGlite,
  role: Role,
  userId: string | null,
  sql: string,
): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ""}', true);`);
    const results = await tx.exec(sql);
    await tx.rollback();
    return (results.at(-1)?.rows ?? []) as T[];
  });
}

/** Same as `as`, but the changes are kept (for setting up fixtures through the real policies). */
export async function commitAs<T = Record<string, unknown>>(
  db: PGlite,
  role: Role,
  userId: string | null,
  sql: string,
): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ""}', true);`);
    const results = await tx.exec(sql);
    return (results.at(-1)?.rows ?? []) as T[];
  });
}
