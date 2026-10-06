// Database-level guarantees for the Google Calendar connection (public.google_calendar_connections)
// and get_google_calendar_credentials(). Ciphertexts are fake fixtures in the stored format.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USER_A, USER_B, as, commitAs, createDatabase } from "./harness";

let db: PGlite;

const CIPHER_A = "v1.k1.AAAAAAAAAAAAAAAA.cmVmcmVzaC1BLWNpcGhlcnRleHQtZmFrZQ";
const ACCESS_A = "v1.k1.BBBBBBBBBBBBBBBB.YWNjZXNzLUEtY2lwaGVydGV4dC1mYWtlLXg";
const CIPHER_B = "v1.k1.CCCCCCCCCCCCCCCC.cmVmcmVzaC1CLWNpcGhlcnRleHQtZmFrZQ";

const connect = (refresh: string, extra = "") =>
  `insert into public.google_calendar_connections (google_account_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at${extra ? ", selected_calendar_id, selected_calendar_name" : ""})
   values ('ana@example.com', '${refresh}', null, null${extra})`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

before(async () => {
  db = await createDatabase();
  await commitAs(
    db,
    "authenticated",
    USER_A,
    `insert into public.google_calendar_connections (google_account_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, selected_calendar_id, selected_calendar_name)
     values ('ana@example.com', '${CIPHER_A}', '${ACCESS_A}', now() + interval '1 hour', 'traza@group.calendar.google.com', 'TRAZA')`,
  );
  await commitAs(db, "authenticated", USER_B, connect(CIPHER_B));
});

describe("google_calendar_connections: schema", () => {
  it("fills owner, status and timestamps; one connection per user", async () => {
    const [row] = await as(db, "authenticated", USER_A, `select user_id, status, selected_calendar_name, connected_at from public.google_calendar_connections`);
    assert.deepEqual([row.user_id, row.status, row.selected_calendar_name], [USER_A, "connected", "TRAZA"]);
    assert.ok(row.connected_at instanceof Date);
    await rejects(as(db, "authenticated", USER_A, connect(CIPHER_A)), /google_calendar_connections_user_key/);
  });

  it("refuses anything that is not server ciphertext (no plain Google tokens)", async () => {
    for (const plain of ["1//0gFAKErefreshTOKENvalue-not-real", "ya29.a0FAKEaccessTOKEN", "v1.k1.short.x", "djEuazEu"]) {
      await rejects(as(db, "authenticated", USER_A, `delete from public.google_calendar_connections; ${connect(plain)}`), /refresh_format/);
    }
    await rejects(
      as(db, "authenticated", USER_A, `update public.google_calendar_connections set access_token_ciphertext = 'ya29.a0FAKEaccessTOKEN'`),
      /access_format/,
    );
  });

  it("keeps status and tokens consistent", async () => {
    await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_connections set status = 'revoked'`), /status_tokens/);
    await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_connections set refresh_token_ciphertext = null`), /status_tokens/);
    await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_connections set status = 'paused'`), /status_(valid|tokens)/);
    const [row] = await as(
      db,
      "authenticated",
      USER_A,
      `update public.google_calendar_connections
          set status = 'revoked', refresh_token_ciphertext = null, access_token_ciphertext = null, access_token_expires_at = null
        returning status, selected_calendar_name`,
    );
    assert.deepEqual(row, { status: "revoked", selected_calendar_name: "TRAZA" });
  });

  it("requires an expiry with an access token, and a name with a calendar", async () => {
    await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_connections set access_token_expires_at = null`), /access_expiry/);
    await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_connections set selected_calendar_name = null`), /calendar_pair/);
  });
});

describe("google_calendar_connections: privileges and RLS", () => {
  it("denies anon everything, including the credentials function", async () => {
    await rejects(as(db, "anon", null, `select id from public.google_calendar_connections`), /permission denied/);
    await rejects(as(db, "anon", null, connect(CIPHER_A)), /permission denied/);
    await rejects(as(db, "anon", null, `select * from public.get_google_calendar_credentials()`), /permission denied/);
  });

  it("never lets a client select the ciphertext columns, even its own", async () => {
    for (const column of ["*", "refresh_token_ciphertext", "access_token_ciphertext"]) {
      await rejects(as(db, "authenticated", USER_A, `select ${column} from public.google_calendar_connections`), /permission denied/);
    }
    // ... nor through RETURNING.
    await rejects(
      as(db, "authenticated", USER_A, `update public.google_calendar_connections set selected_calendar_name = 'X' returning refresh_token_ciphertext`),
      /permission denied/,
    );
  });

  it("shows, changes and deletes only the caller's own connection", async () => {
    const visible = await as<{ user_id: string }>(db, "authenticated", USER_B, `select user_id from public.google_calendar_connections`);
    assert.deepEqual(visible, [{ user_id: USER_B }]);
    const [{ n: updated }] = await as<{ n: number }>(
      db,
      "authenticated",
      USER_B,
      `with u as (update public.google_calendar_connections set selected_calendar_name = 'Hack', selected_calendar_id = 'x' where user_id = '${USER_A}' returning 1)
       select count(*)::int as n from u`,
    );
    assert.equal(updated, 0);
    const [{ n: deleted }] = await as<{ n: number }>(
      db,
      "authenticated",
      USER_B,
      `with d as (delete from public.google_calendar_connections where user_id = '${USER_A}' returning 1) select count(*)::int as n from d`,
    );
    assert.equal(deleted, 0);
  });

  it("does not let clients write the owner, id or timestamps", async () => {
    await rejects(
      as(db, "authenticated", USER_A, `insert into public.google_calendar_connections (user_id, refresh_token_ciphertext) values ('${USER_B}', '${CIPHER_A}')`),
      /permission denied/,
    );
    for (const column of [`user_id = '${USER_B}'`, `id = gen_random_uuid()`, `created_at = now()`, `updated_at = now()`]) {
      await rejects(as(db, "authenticated", USER_A, `update public.google_calendar_connections set ${column}`), /permission denied/);
    }
  });
});

describe("get_google_calendar_credentials", () => {
  it("returns only the caller's own ciphertext", async () => {
    const rows = await as(db, "authenticated", USER_A, `select * from public.get_google_calendar_credentials()`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].refresh_token_ciphertext, CIPHER_A);
    assert.equal(rows[0].access_token_ciphertext, ACCESS_A);
    const [b] = await as(db, "authenticated", USER_B, `select * from public.get_google_calendar_credentials()`);
    assert.deepEqual([b.refresh_token_ciphertext, b.access_token_ciphertext], [CIPHER_B, null]);
  });

  it("returns nothing for a revoked connection or a user without one", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `update public.google_calendar_connections set status = 'revoked', refresh_token_ciphertext = null, access_token_ciphertext = null, access_token_expires_at = null;
       select * from public.get_google_calendar_credentials()`,
    );
    assert.equal(rows.length, 0);
    const none = await as(db, "authenticated", USER_A, `delete from public.google_calendar_connections; select * from public.get_google_calendar_credentials()`);
    assert.equal(none.length, 0);
  });

  it("rejects a signed-in role without a user id, and takes no parameters", async () => {
    await rejects(as(db, "authenticated", null, `select * from public.get_google_calendar_credentials()`), /Not authenticated/);
    await rejects(as(db, "authenticated", USER_A, `select * from public.get_google_calendar_credentials('${USER_B}')`), /does not exist/);
  });

  it("is SECURITY DEFINER with an empty search_path, executable only by authenticated", async () => {
    const [fn] = await db
      .query<{ prosecdef: boolean; proconfig: string[]; anon: boolean; auth: boolean }>(
        `select prosecdef, proconfig, has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as auth
           from pg_proc where proname = 'get_google_calendar_credentials'`,
      )
      .then((r) => r.rows);
    assert.deepEqual(fn, { prosecdef: true, proconfig: ['search_path=""'], anon: false, auth: true });
  });
});

describe("google_calendar_connections: how the server writes", () => {
  // Regression: an upsert (INSERT … ON CONFLICT DO UPDATE SET col = EXCLUDED.col) reads the new
  // ciphertext through EXCLUDED, which needs SELECT on that column — deliberately not granted. That
  // made every real connection fail at the database step. The server therefore updates, then inserts.
  it("cannot upsert ciphertext through EXCLUDED (documented limitation)", async () => {
    await rejects(
      as(
        db,
        "authenticated",
        USER_A,
        `insert into public.google_calendar_connections (status, refresh_token_ciphertext) values ('connected', '${CIPHER_A}')
         on conflict (user_id) do update set refresh_token_ciphertext = excluded.refresh_token_ciphertext`,
      ),
      /permission denied/,
    );
  });

  it("reconnects by UPDATE … RETURNING id, and connects a new user by INSERT", async () => {
    const reconnected = await as(
      db,
      "authenticated",
      USER_A,
      `update public.google_calendar_connections
          set status = 'connected', refresh_token_ciphertext = '${CIPHER_A}', access_token_ciphertext = '${ACCESS_A}',
              access_token_expires_at = now() + interval '1 hour', connected_at = now(),
              google_account_email = 'ana@example.com', selected_calendar_id = null, selected_calendar_name = null
        where user_id = '${USER_A}'
        returning id`,
    );
    assert.equal(reconnected.length, 1);
    const fresh = await as(
      db,
      "authenticated",
      USER_A,
      `delete from public.google_calendar_connections;
       insert into public.google_calendar_connections (google_account_email, status, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, connected_at, selected_calendar_id, selected_calendar_name)
       values ('ana@example.com', 'connected', '${CIPHER_A}', '${ACCESS_A}', now() + interval '1 hour', now(), null, null);
       select count(*)::int as n from public.google_calendar_connections`,
    );
    assert.deepEqual(fresh, [{ n: 1 }]);
  });

  it("reports a concurrent second insert as a unique violation (23505), which the server retries as an update", async () => {
    await assert.rejects(as(db, "authenticated", USER_A, connect(CIPHER_A)), (error: Error & { code?: string }) => error.code === "23505");
  });
});

describe("google_calendar_connections: disconnect", () => {
  it("deleting the connection leaves calendar events untouched", async () => {
    const rows = await as(
      db,
      "authenticated",
      USER_A,
      `insert into public.calendar_events (title, event_date, all_day) values ('Entrega', '2026-10-12', true);
       delete from public.google_calendar_connections;
       select (select count(*)::int from public.calendar_events) as events,
              (select count(*)::int from public.google_calendar_connections) as connections`,
    );
    assert.deepEqual(rows, [{ events: 1, connections: 0 }]);
  });
});
