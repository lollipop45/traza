import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/validation";

// The ONLY way scheduled work touches the database. The privileged client (secret key) bypasses
// RLS, so user scoping must not depend on each query remembering a filter: a ScheduledScope is bound
// to one target user (chosen by the scheduler's own server-side candidate queries, never by a
// request) and every operation it offers is scoped by construction:
//
//   select(table, columns)   SELECT … WHERE user_id = <user>             (then narrow further)
//   update(table, values)    UPDATE … SET values WHERE user_id = <user>  (user_id itself not settable)
//   delete(table)            DELETE … WHERE user_id = <user>
//   insert(table, values)    INSERT … with user_id = <user> (a caller-supplied user_id is impossible)
//   rpc(fn, args)            only scheduler_* functions, always with p_user_id = <user>
//
// Only tables that have a user_id column are accepted. The underlying client is never exposed, so
// the scheduled stores (lib/scheduler/stores/) have no unscoped query or mutation available.
// tests/unit/scheduler.test.ts enforces that nothing else in the scheduler uses the client for writes.

type Tables = Database["public"]["Tables"];
type Functions = Database["public"]["Functions"];

/** Tables with a user_id column (every per-user table). */
export type OwnedTable = { [K in keyof Tables]: Tables[K]["Row"] extends { user_id: string } ? K : never }[keyof Tables];

/** The scheduler-only database functions (executable only with the secret key, never by anon / authenticated). */
export type SchedulerFunction = Extract<keyof Functions, `scheduler_${string}`>;

type SchedulerArgs<F extends SchedulerFunction> = Omit<Functions[F]["Args"], "p_user_id">;

export function createScheduledScope(admin: AdminClient, userId: string) {
  if (!isUuid(userId)) throw new Error("Scheduled scope needs a user id");
  // Untyped view of the same client: table names and written values are typed below, while row
  // types are declared by each store (inferring them per call across every table is too costly for
  // the type checker).
  const db = admin as unknown as SupabaseClient;

  const scope = {
    userId,

    /** `Row` is the shape of `columns` (declared by the store, as with the typed client). */
    select<Row = Record<string, unknown>>(table: OwnedTable, columns: string, options?: { count?: "exact"; head?: boolean }) {
      return db.from(table).select<string, Row>(columns, options).eq("user_id", userId);
    },

    update<T extends OwnedTable>(table: T, values: Omit<Tables[T]["Update"], "user_id">) {
      const safe: Record<string, unknown> = { ...values };
      delete safe.user_id;
      return db.from(table).update(safe).eq("user_id", userId);
    },

    delete(table: OwnedTable) {
      return db.from(table).delete().eq("user_id", userId);
    },

    insert<T extends OwnedTable>(table: T, values: Omit<Tables[T]["Insert"], "user_id">) {
      return db.from(table).insert({ ...values, user_id: userId });
    },

    rpc<F extends SchedulerFunction>(fn: F, args: SchedulerArgs<F>) {
      if (!fn.startsWith("scheduler_")) throw new Error("Scheduled scope only calls scheduler_* functions");
      return db.rpc(fn, { ...args, p_user_id: userId });
    },
  };
  return Object.freeze(scope);
}

export type ScheduledScope = ReturnType<typeof createScheduledScope>;
