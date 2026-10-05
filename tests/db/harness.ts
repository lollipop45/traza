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

  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  return db;
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
