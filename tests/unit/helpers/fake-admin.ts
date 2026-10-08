// Test double of the privileged Supabase client (lib/supabase/admin.ts): an in-memory table store
// behind the part of the query-builder API the scheduler uses, plus RPC calls. It RECORDS every
// operation (table, filters, written values, RPC arguments) so tests can prove that each statement
// of scheduled work is pinned to its target user. No network, no real database, no real key, and
// no Auth API at all (calling one fails the test).
import type { AdminClient } from "@/lib/supabase/admin";

type Row = Record<string, unknown>;
export type Filter = { column: string; op: string; value: unknown };
export type Operation =
  | { kind: "select" | "update" | "delete"; table: string; columns?: string; values?: Row; filters: Filter[] }
  | { kind: "insert"; table: string; values: Row; filters: Filter[] }
  | { kind: "rpc"; fn: string; args: Row; filters: Filter[] };

export type FakeAdmin = {
  client: AdminClient;
  tables: Record<string, Row[]>;
  /** Every select, for column checks. */
  selects: { table: string; columns: string }[];
  operations: Operation[];
  /** Writes only (insert / update / delete / rpc). */
  writes: () => Operation[];
  failing: Set<string>;
  rpcResults: Map<string, (args: Row) => { data: unknown; error: unknown }>;
};

const matches = (row: Row, filter: Filter) => {
  switch (filter.op) {
    case "eq":
      return row[filter.column] === filter.value;
    case "neq":
      return row[filter.column] !== filter.value;
    case "in":
      return (filter.value as unknown[]).includes(row[filter.column]);
    case "lte":
      return String(row[filter.column]) <= String(filter.value);
    case "gte":
      return String(row[filter.column]) >= String(filter.value);
    case "not.is.null":
      return row[filter.column] !== null && row[filter.column] !== undefined;
    default:
      throw new Error(`fake admin: unsupported filter ${filter.op}`);
  }
};

export function fakeAdmin(tables: Record<string, Row[]> = {}): FakeAdmin {
  const selects: FakeAdmin["selects"] = [];
  const operations: Operation[] = [];
  const failing = new Set<string>();
  const rpcResults: FakeAdmin["rpcResults"] = new Map();

  function from(table: string) {
    const filters: Filter[] = [];
    let kind: "select" | "update" | "delete" | "insert" = "select";
    let columns = "*";
    let returning: string | null = null;
    let values: Row = {};
    let limit = Infinity;
    let range: [number, number] | null = null;
    let order: string | null = null;
    let single = false;
    let recorded = false;

    const project = (rows: Row[], cols: string) =>
      cols === "*" ? rows : rows.map((row) => Object.fromEntries(cols.split(",").map((c) => c.trim()).map((c) => [c, row[c] ?? null])));

    const run = () => {
      if (!recorded) {
        recorded = true;
        operations.push({ kind, table, filters: [...filters], ...(kind === "select" ? { columns } : {}), ...(kind === "update" || kind === "insert" ? { values } : {}) } as Operation);
      }
      if (failing.has(table)) return { data: null, error: { message: "fake failure", code: "XX000" } };
      const store = (tables[table] ??= []);
      if (kind === "insert") {
        store.push({ ...values });
        return { data: null, error: null };
      }
      let rows = store.filter((row) => filters.every((filter) => matches(row, filter)));
      if (kind === "update") {
        for (const row of rows) Object.assign(row, values);
        return { data: returning ? project(rows, returning) : null, error: null };
      }
      if (kind === "delete") {
        tables[table] = store.filter((row) => !rows.includes(row));
        return { data: returning ? project(rows, returning) : null, error: null };
      }
      if (order) rows = [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      rows = rows.slice(0, limit);
      const projected = project(rows, columns);
      if (single) {
        if (projected.length > 1) return { data: null, error: { message: "more than one row" } };
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    };

    const filter = (column: string, op: string, value: unknown) => (filters.push({ column, op, value }), builder);
    const builder = {
      select(cols: string = "*") {
        if (kind === "select") {
          columns = cols;
          selects.push({ table, columns: cols });
        } else {
          returning = cols;
        }
        return builder;
      },
      insert(row: Row) {
        kind = "insert";
        values = { ...row };
        return builder;
      },
      update(row: Row) {
        kind = "update";
        values = { ...row };
        return builder;
      },
      delete() {
        kind = "delete";
        return builder;
      },
      eq: (column: string, value: unknown) => filter(column, "eq", value),
      neq: (column: string, value: unknown) => filter(column, "neq", value),
      in: (column: string, value: unknown[]) => filter(column, "in", value),
      lte: (column: string, value: unknown) => filter(column, "lte", value),
      gte: (column: string, value: unknown) => filter(column, "gte", value),
      not: (column: string, operator: string, value: unknown) => {
        if (operator !== "is" || value !== null) throw new Error("fake admin: unsupported not()");
        return filter(column, "not.is.null", null);
      },
      order: (column: string) => ((order = column), builder),
      limit: (n: number) => ((limit = n), builder),
      range: (start: number, end: number) => ((range = [start, end]), builder),
      maybeSingle: () => ((single = true), builder),
      then<T>(resolve: (value: ReturnType<typeof run>) => T, reject?: (reason: unknown) => T) {
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from,
    async rpc(fn: string, args: Row = {}) {
      operations.push({ kind: "rpc", fn, args: { ...args }, filters: [] });
      const result = rpcResults.get(fn);
      return result ? result(args) : { data: null, error: null };
    },
    // The scheduler must never use Supabase Auth (no sessions, no sign-in links).
    get auth(): never {
      throw new Error("fake admin: the scheduler must not use Supabase Auth");
    },
  };
  return {
    client: client as unknown as AdminClient,
    tables,
    selects,
    operations,
    writes: () => operations.filter((operation) => operation.kind !== "select"),
    failing,
    rpcResults,
  };
}
