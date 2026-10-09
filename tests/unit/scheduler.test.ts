import "./helpers/server-only-stub";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import type { LeasedSyncResult, SyncClaim, SyncRecord, SyncStateStore } from "@/lib/canvas/auto-sync";
import { runLeasedCanvasSync } from "@/lib/canvas/auto-sync";
import type { SyncDeps } from "@/lib/canvas/sync";
import { AUTO_SYNC_COOLDOWN_SECONDS } from "@/lib/canvas/sync-policy";
import { runLeasedGoogleSync, type GoogleSyncClaim, type GoogleSyncRecord, type LeasedGoogleSyncDeps } from "@/lib/google-calendar/auto-sync";
import { GOOGLE_AUTO_SYNC_COOLDOWN_SECONDS, type GoogleSyncTrigger } from "@/lib/google-calendar/sync-policy";
import type { StoredSubscription } from "@/lib/notifications/delivery";
import type { PlannedNotification, PlannerEvent, PlannerTask } from "@/lib/notifications/planner";
import { DEFAULT_PREFERENCES, type NotificationPreferences } from "@/lib/notifications/preferences";
import { runDueNotifications, type DeliveryStatus, type NotificationRunDeps } from "@/lib/notifications/run";
import { canvasCandidate, googleCandidates, notificationCandidates } from "@/lib/scheduler/candidates";
import {
  bearerToken,
  canvasOwner,
  distinctUsers,
  isAuthorizedSchedulerRequest,
  isDeliveryOpen,
  isSyncDue,
  readSchedulerSecret,
  SCHEDULER_CRON_SCHEDULE,
  SCHEDULER_HARD_DEADLINE_MS,
  SCHEDULER_MAX_DURATION_SECONDS,
  SCHEDULER_MAX_USERS,
  SCHEDULER_NEW_WORK_MS,
} from "@/lib/scheduler/policy";
import { runScheduler, schedulerLogLine, type SchedulerDeps, type SchedulerResult } from "@/lib/scheduler/run";
import { createScheduledDependencies } from "@/lib/scheduler/scoped-deps";
import { createScheduledScope } from "@/lib/scheduler/scope";
import { createAdminClient, isSupabaseSecretKey, readSupabaseSecretKey } from "@/lib/supabase/admin";
import { fakeAdmin } from "./helpers/fake-admin";
import { ACCESS, config, independent, NEW_ACCESS, NOW as GOOGLE_NOW, REFRESH, setup } from "./helpers/google-fake";

// The trusted background scheduler. Everything is faked: no Supabase, no Canvas, no
// Google, no push service, no production URL, and only obviously fake secrets.

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, "");
function files(dir: string, accept: (file: string) => boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? files(full, accept) : accept(full) ? [full] : [];
  });
}
const sourceFiles = () =>
  ["app", "lib", "components"].flatMap((dir) => files(path.join(ROOT, dir), (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("database.types.ts")));
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

const SECRET = "test-scheduler-secret-0123456789-abcdefghijkl"; // fake, ≥ 32 chars
const USER_A = "00000000-0000-4000-8000-0000000000aa";
const USER_B = "00000000-0000-4000-8000-0000000000bb";
const MIN = 60_000;

// Fake configuration (format-valid, not real credentials) for the candidate queries' config checks.
const FAKE_ENV: Record<string, string> = {
  WEB_PUSH_VAPID_PUBLIC_KEY: `B${"A".repeat(86)}`,
  WEB_PUSH_VAPID_PRIVATE_KEY: "A".repeat(43),
  WEB_PUSH_SUBJECT: "mailto:scheduler-test@example.com",
  CANVAS_BASE_URL: "https://canvas.example.edu",
  CANVAS_ACCESS_TOKEN: "fake-canvas-token-0123456789",
  GOOGLE_CLIENT_ID: "123456789012-fakeclientid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-FAKE-client-secret-not-real",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/integrations/google/callback",
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = [...Object.keys(FAKE_ENV), "SCHEDULER_SECRET", "SUPABASE_SECRET_KEY", "VERCEL_ENV"];
before(() => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, FAKE_ENV);
});
after(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const headers = (values: Record<string, string>) => new Headers(values);
/** A lane run that must not happen in that test. */
const unexpected = async (): Promise<never> => {
  throw new Error("this lane should not run a user");
};

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

describe("scheduler authentication (Authorization: Bearer <SCHEDULER_SECRET>)", () => {
  const env = { SCHEDULER_SECRET: SECRET };

  it("missing, wrong, malformed or differently-schemed credentials are rejected", () => {
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong-secret-0123456789-0123456789-xyz" },
      { authorization: `bearer ${SECRET}` },
      { authorization: `Bearer  ${SECRET}` },
      { authorization: `Bearer ${SECRET} extra` },
      { authorization: `Basic ${Buffer.from(`x:${SECRET}`).toString("base64")}` },
      { authorization: SECRET },
      { authorization: `Bearer ${SECRET}x` },
      { authorization: `Bearer ${SECRET.slice(0, -1)}` },
    ];
    for (const value of cases) {
      assert.equal(isAuthorizedSchedulerRequest(headers(value), env), false, JSON.stringify(value));
    }
  });

  it("the exact bearer token is accepted", () => {
    assert.equal(isAuthorizedSchedulerRequest(headers({ authorization: `Bearer ${SECRET}` }), env), true);
    assert.equal(bearerToken(headers({ authorization: `Bearer ${SECRET}` })), SECRET);
  });

  it("an unset or weak SCHEDULER_SECRET rejects everything (never an open endpoint)", () => {
    for (const configured of [{}, { SCHEDULER_SECRET: "" }, { SCHEDULER_SECRET: "short-secret" }, { SCHEDULER_SECRET: "x".repeat(31) }, { SCHEDULER_SECRET: `${"x".repeat(40)} y` }]) {
      assert.equal(readSchedulerSecret(configured), null);
      const value = configured.SCHEDULER_SECRET ?? "";
      assert.equal(isAuthorizedSchedulerRequest(headers({ authorization: `Bearer ${value}` }), configured), false);
    }
    // Only the server-only name is read.
    assert.equal(readSchedulerSecret({ NEXT_PUBLIC_SCHEDULER_SECRET: SECRET }), null);
  });

  it("the comparison is constant-time over hashes (no early exit on the first differing character)", () => {
    const source = code("lib/scheduler/policy.ts");
    assert.match(source, /timingSafeEqual\(digest\(provided\), digest\(/);
    assert.doesNotMatch(source, /provided\s*===\s*expected|expected\s*===\s*provided/);
  });
});

describe("POST /api/internal/scheduler", () => {
  const url = "http://localhost:3000/api/internal/scheduler";
  const route = () => import("@/app/api/internal/scheduler/route");

  it("401 without the header, with a wrong one, and with the secret in a query parameter, body or cookie", async () => {
    process.env.SCHEDULER_SECRET = SECRET;
    const { POST } = await route();
    const attempts = [
      new NextRequest(url, { method: "POST" }),
      new NextRequest(url, { method: "POST", headers: { authorization: "Bearer not-the-secret-0123456789-0123456789" } }),
      new NextRequest(`${url}?secret=${SECRET}&token=${SECRET}&authorization=Bearer%20${SECRET}`, { method: "POST" }),
      new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET, authorization: `Bearer ${SECRET}` }) }),
      new NextRequest(url, { method: "POST", headers: { cookie: `scheduler_secret=${SECRET}; authorization=Bearer ${SECRET}` } }),
      new NextRequest(url, { method: "POST", headers: { "x-scheduler-secret": SECRET } }),
    ];
    for (const request of attempts) {
      const response = await POST(request);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });

  it("an unconfigured SCHEDULER_SECRET answers exactly like a wrong one", async () => {
    delete process.env.SCHEDULER_SECRET;
    const { POST } = await route();
    const response = await POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
  });

  it("correct secret is accepted; without the Supabase secret key it does nothing and says only not_configured", async () => {
    process.env.SCHEDULER_SECRET = SECRET;
    delete process.env.SUPABASE_SECRET_KEY;
    const { POST } = await route();
    const response = await POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "not_configured" });
  });

  it("POST only, no session, no cookies, no body, no query, no same-origin rule; bounded duration", async () => {
    const source = code("app/api/internal/scheduler/route.ts");
    const mod = await route();
    assert.equal(typeof mod.POST, "function");
    for (const verb of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal((mod as Record<string, unknown>)[verb], undefined, verb);
    assert.equal(mod.maxDuration, SCHEDULER_MAX_DURATION_SECONDS);
    assert.ok(SCHEDULER_MAX_DURATION_SECONDS * 1000 > SCHEDULER_HARD_DEADLINE_MS);
    assert.ok(SCHEDULER_HARD_DEADLINE_MS < 5 * MIN, "engine work ends inside the 5-minute database leases");
    assert.ok(SCHEDULER_NEW_WORK_MS < SCHEDULER_HARD_DEADLINE_MS);
    for (const forbidden of [/request\.(json|text|formData|arrayBuffer|body)\b/, /searchParams/, /cookies/, /getSessionUser|requireUser/, /isSameOriginRequest/, /lib\/supabase\/server/]) {
      assert.doesNotMatch(source, forbidden);
    }
    assert.match(source, /isAuthorizedSchedulerRequest\(request\.headers\)/);
  });

  it("the proxy passes the scheduler and the health check through untouched; other API writes still need a session", async () => {
    const { isServerToServerPath, isPublicPath } = await import("@/lib/auth/routes");
    assert.equal(isServerToServerPath("/api/internal/scheduler"), true);
    assert.equal(isServerToServerPath("/api/health"), true);
    for (const other of ["/api/internal/scheduler/x", "/api/internal", "/api/integrations/canvas/auto-sync", "/api/notifications/check", "/api/healthz", "/"]) {
      assert.equal(isServerToServerPath(other), false, other);
    }
    assert.equal(isPublicPath("/api/internal/scheduler"), false);
    const proxy = code("lib/supabase/proxy.ts");
    // The early return happens before any Supabase client or cookie is touched.
    assert.ok(proxy.indexOf("isServerToServerPath(request.nextUrl.pathname)") < proxy.indexOf("getSupabaseEnv()"));
  });
});

// ---------------------------------------------------------------------------------------------
// Privileged client isolation
// ---------------------------------------------------------------------------------------------

describe("privileged Supabase client (SUPABASE_SECRET_KEY)", () => {
  it("is a server-only module using supabase-js directly, with no session persistence, refresh or URL detection", () => {
    const source = read("lib/supabase/admin.ts");
    assert.match(source, /^import "server-only";/);
    assert.match(source, /from "@supabase\/supabase-js"/);
    assert.doesNotMatch(source, /from "@supabase\/ssr"|from "next\/headers"|cookies\(|getAll\(|setAll\(/);
    assert.match(source, /persistSession: false, autoRefreshToken: false, detectSessionInUrl: false/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_SUPABASE_SECRET|SUPABASE_SERVICE_ROLE/);
  });

  it("accepts only sb_secret_ keys from SUPABASE_SECRET_KEY (no legacy service_role JWT, no NEXT_PUBLIC_ variant)", () => {
    assert.equal(isSupabaseSecretKey("sb_secret_FAKEfakeFAKEfake0123456789"), true);
    for (const value of ["", "sb_publishable_FAKEfakeFAKEfake0123", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake", "sb_secret_short", "sb_secret_has space inside 012345"]) {
      assert.equal(isSupabaseSecretKey(value), false, value);
    }
    assert.equal(readSupabaseSecretKey({ NEXT_PUBLIC_SUPABASE_SECRET_KEY: "sb_secret_FAKEfakeFAKEfake0123456789" }), null);
    assert.equal(readSupabaseSecretKey({ SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.fake" }), null);
  });

  it("is null without its configuration; with it, a fresh client is built without any network call", () => {
    assert.equal(createAdminClient({}), null);
    assert.equal(createAdminClient({ NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co" }), null);
    assert.equal(createAdminClient({ SUPABASE_SECRET_KEY: "sb_secret_FAKEfakeFAKEfake0123456789" }), null);
    const env = { NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_FAKEfakeFAKEfake0123456789" };
    const a = createAdminClient(env);
    const b = createAdminClient(env);
    assert.ok(a && b && a !== b, "never a shared module-level client");
  });

  it("only the scheduler imports it; no client component, Server Action, page or other route reaches it", () => {
    const allowed = new Set(["lib/scheduler/candidates.ts", "lib/scheduler/deps.ts", "lib/scheduler/scope.ts", "lib/scheduler/scoped-deps.ts"]);
    for (const file of sourceFiles()) {
      const source = read(rel(file));
      const name = rel(file);
      if (/@\/lib\/supabase\/admin|supabase\/admin"/.test(source)) assert.ok(allowed.has(name), `${name} imports the privileged client`);
      if (/^\s*["']use (client|server)["']/m.test(source)) assert.doesNotMatch(source, /lib\/supabase\/admin|lib\/scheduler/, `${name} must not reach privileged code`);
      if (name.startsWith("app/") && name !== "app/api/internal/scheduler/route.ts") assert.doesNotMatch(source, /lib\/scheduler|lib\/supabase\/admin/, name);
      if (name.startsWith("components/")) assert.doesNotMatch(source, /lib\/scheduler|lib\/supabase\/admin/, name);
    }
    // Everything in lib/scheduler that can reach the database is server-only (policy.ts and run.ts are pure).
    for (const file of files(path.join(ROOT, "lib", "scheduler"), (f) => f.endsWith(".ts")).map(rel)) {
      if (file === "lib/scheduler/policy.ts" || file === "lib/scheduler/run.ts") assert.doesNotMatch(read(file), /lib\/supabase|from "\.\/(scope|stores|deps|scoped-deps|candidates)"/, file);
      else assert.match(read(file), /^import "server-only";/, file);
    }
  });

  it("scheduled stores never see the privileged client: every database access goes through the user-bound scope", () => {
    const stores = files(path.join(ROOT, "lib", "scheduler", "stores"), (f) => f.endsWith(".ts")).map(rel);
    assert.deepEqual(stores.sort(), ["lib/scheduler/stores/canvas.ts", "lib/scheduler/stores/google.ts", "lib/scheduler/stores/notifications.ts"]);
    for (const file of stores) {
      const source = code(file);
      // No client of any kind: the only database handle a store receives is `scope: ScheduledScope`.
      assert.doesNotMatch(source, /AdminClient|SupabaseClient|lib\/supabase\/(admin|server)|createClient|\badmin\b|\.from\(|\.upsert\(/, file);
      assert.match(source, /\(scope: ScheduledScope[,)]/, file);
    }
    // Outside scope.ts, no scheduler file writes with the client or calls a database function
    // (policy.ts is pure and imports no client; its only ".update(" is a SHA-256 hash).
    for (const file of ["lib/scheduler/candidates.ts", "lib/scheduler/deps.ts", "lib/scheduler/scoped-deps.ts", "lib/scheduler/run.ts"]) {
      assert.doesNotMatch(code(file), /\.(insert|update|upsert|delete|rpc)\(/, file);
    }
  });

  it("the candidate queries never select token ciphertext, push endpoints or keys, and never write", () => {
    const source = code("lib/scheduler/candidates.ts");
    assert.doesNotMatch(source, /ciphertext|p256dh|"auth"|endpoint/);
    assert.doesNotMatch(source, /\.(insert|update|upsert|delete|rpc)\(/);
  });

  it("no NEXT_PUBLIC_ variant of a server secret exists anywhere in the source", () => {
    for (const file of sourceFiles()) {
      const source = read(rel(file));
      assert.doesNotMatch(source, /NEXT_PUBLIC_(SUPABASE_SECRET|SCHEDULER|SERVICE_ROLE|GROQ|CANVAS|GOOGLE|WEB_PUSH_VAPID_PRIVATE)/, rel(file));
    }
  });

  it("the built browser bundle (if present) has none of the scheduler's secrets or privileged code", () => {
    const bundle = files(path.join(ROOT, ".next", "static"), (f) => f.endsWith(".js"));
    if (bundle.length === 0) return;
    const text = bundle.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const needle of ["SUPABASE_SECRET_KEY", "sb_secret_", "SCHEDULER_SECRET", "traza_scheduler_secret", "createAdminClient", "generateLink", "verifyOtp", "createScheduledScope", "scheduler_claim", "isAuthorizedSchedulerRequest"]) {
      assert.ok(!text.includes(needle), needle);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// No Auth sessions; interactive paths unchanged
// ---------------------------------------------------------------------------------------------

const schedulerSources = () => [
  ...files(path.join(ROOT, "lib", "scheduler"), (f) => f.endsWith(".ts")).map(rel),
  "app/api/internal/scheduler/route.ts",
  "lib/supabase/admin.ts",
];

describe("no user impersonation: scheduled work is system work, not a sign-in", () => {
  it("no sign-in link, OTP / magic-link redemption, session creation or sign-out in the scheduler", () => {
    for (const file of schedulerSources()) {
      const source = read(file);
      assert.doesNotMatch(source, /generateLink|verifyOtp|magic.?link|token_hash|hashed_token|signIn|signOut|setSession|refreshSession|exchangeCodeForSession|getSession|getUser/i, file);
      assert.doesNotMatch(code(file), /\.auth\b/, `${file} must not use Supabase Auth`);
    }
  });

  it("the impersonation modules are gone and nothing in the app scopes a user client by async context", () => {
    for (const removed of ["lib/supabase/user-scope.ts", "lib/scheduler/user-session.ts"]) assert.equal(existsSync(path.join(ROOT, removed)), false, removed);
    for (const file of sourceFiles()) {
      assert.doesNotMatch(read(rel(file)), /AsyncLocalStorage|runInUserScope|scopedSupabaseClient|scopedUserId|generateLink|verifyOtp/, rel(file));
    }
  });

  it("running every scheduled store method never touches Supabase Auth (the fake client fails the test if it does)", async () => {
    const world = storeSweep();
    await world.run(); // the fake's `auth` getter throws: reaching here means Auth was never used
    assert.ok(world.admin.operations.length > 20);
  });

  it("interactive requests still use the user's session cookie client and RLS, untouched by the scheduler", () => {
    const server = code("lib/supabase/server.ts");
    assert.match(server, /createServerClient<Database>\(url, publishableKey/);
    assert.match(server, /await cookies\(\)/);
    const session = code("lib/auth/session.ts");
    assert.match(session, /supabase\.auth\.getClaims\(\)/);
    for (const file of ["lib/supabase/server.ts", "lib/auth/session.ts", "lib/supabase/proxy.ts"]) {
      assert.doesNotMatch(code(file), /scheduler|lib\/supabase\/admin|createAdminClient|user-scope|AsyncLocalStorage/i, file);
    }
    for (const file of [
      "lib/notifications/store.ts",
      "lib/canvas/sync-store.ts",
      "lib/canvas/sync-state-store.ts",
      "lib/canvas/links.ts",
      "lib/google-calendar/store.ts",
      "lib/google-calendar/sync-store.ts",
      "lib/google-calendar/sync-state-store.ts",
    ]) {
      const source = code(file);
      assert.match(source, /from "@\/lib\/supabase\/server"/, file);
      assert.doesNotMatch(source, /lib\/supabase\/admin|lib\/scheduler|scheduler_/, file);
    }
    for (const route of ["app/api/integrations/canvas/auto-sync/route.ts", "app/api/integrations/google/auto-sync/route.ts", "app/api/notifications/check/route.ts"]) {
      const source = code(route);
      assert.match(source, /getSessionUser\(\)/, route);
      assert.match(source, /isSameOriginRequest\(/, route);
      assert.doesNotMatch(source, /lib\/scheduler|lib\/supabase\/admin/, route);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The user-bound scope
// ---------------------------------------------------------------------------------------------

const ROWS = () => ({
  tasks: [
    { id: "ta", user_id: USER_A, title: "Tarea de A", status: "pending", due_date: "2026-10-09", source: "manual", external_id: null },
    { id: "tb", user_id: USER_B, title: "Tarea de B", status: "pending", due_date: "2026-10-09", source: "manual", external_id: null },
  ],
  google_calendar_item_links: [
    { id: "la", user_id: USER_A, content_hash: "a" },
    { id: "lb", user_id: USER_B, content_hash: "b" },
  ],
});

describe("scheduled scope: every statement is pinned to the target user", () => {
  it("needs a real user id", () => {
    for (const bad of ["", "not-a-uuid", "*", `${USER_A}' or '1'='1`]) assert.throws(() => createScheduledScope(fakeAdmin().client, bad), bad);
  });

  it("exposes no client, only scoped operations, and cannot be altered", () => {
    const scope = createScheduledScope(fakeAdmin().client, USER_A);
    assert.deepEqual(Object.keys(scope).sort(), ["delete", "insert", "rpc", "select", "update", "userId"]);
    assert.ok(Object.isFrozen(scope));
    assert.throws(() => Object.assign(scope, { userId: USER_B }));
  });

  it("select: only the target user's rows, even if a query asks for another user", async () => {
    const admin = fakeAdmin(ROWS());
    const scope = createScheduledScope(admin.client, USER_A);
    assert.deepEqual((await scope.select<{ id: string }>("tasks", "id")).data, [{ id: "ta" }]);
    assert.deepEqual((await scope.select("tasks", "id").eq("user_id", USER_B)).data, []);
  });

  it("update / delete never reach another user's rows; user_id can never be changed", async () => {
    const admin = fakeAdmin(ROWS());
    const scope = createScheduledScope(admin.client, USER_A);
    await scope.update("google_calendar_item_links", { content_hash: "changed", user_id: USER_B } as never).eq("id", "lb");
    await scope.update("google_calendar_item_links", { content_hash: "changed-a", user_id: USER_B } as never).eq("id", "la");
    await scope.delete("tasks").eq("id", "tb");
    assert.deepEqual(admin.tables.google_calendar_item_links, [
      { id: "la", user_id: USER_A, content_hash: "changed-a" },
      { id: "lb", user_id: USER_B, content_hash: "b" },
    ]);
    assert.deepEqual(admin.tables.tasks.map((task) => task.id), ["ta", "tb"]);
  });

  it("insert always writes the target user, even if another user_id is smuggled in", async () => {
    const admin = fakeAdmin();
    const scope = createScheduledScope(admin.client, USER_A);
    await scope.insert("google_calendar_item_links", { google_calendar_id: "c", google_event_id: "e", item_type: "task", content_hash: "h", user_id: USER_B } as never);
    assert.equal(admin.tables.google_calendar_item_links[0].user_id, USER_A);
  });

  it("rpc: only scheduler_* functions, always with p_user_id = the target (a smuggled one is overridden)", async () => {
    const admin = fakeAdmin();
    const scope = createScheduledScope(admin.client, USER_A);
    await scope.rpc("scheduler_claim_canvas_sync", { p_trigger: "automatic", p_lease_seconds: 300, p_user_id: USER_B } as never);
    assert.deepEqual(admin.operations.at(-1), { kind: "rpc", fn: "scheduler_claim_canvas_sync", args: { p_trigger: "automatic", p_lease_seconds: 300, p_user_id: USER_A }, filters: [] });
    for (const fn of ["claim_canvas_sync", "get_google_calendar_credentials", "execute_assistant_action"]) {
      assert.throws(() => scope.rpc(fn as never, {} as never), fn);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Every read and write of the three scheduled engines is scoped
// ---------------------------------------------------------------------------------------------

/** Calls every method of the scheduled stores (no Canvas / Google / push network calls). */
function storeSweep() {
  const admin = fakeAdmin({
    ...ROWS(),
    calendar_events: [
      { id: "ea", user_id: USER_A, title: "Evento de A", event_date: "2026-10-09", start_time: "10:00", all_day: false, source: "manual" },
      { id: "eb", user_id: USER_B, title: "Evento de B", event_date: "2026-10-09", start_time: "10:00", all_day: false, source: "manual" },
    ],
    push_subscriptions: [
      { id: "sa", user_id: USER_A, endpoint: "https://push.example.com/a", p256dh: "k", auth: "a", created_at: "1" },
      { id: "sb", user_id: USER_B, endpoint: "https://push.example.com/b", p256dh: "k", auth: "a", created_at: "2" },
    ],
  });
  const deps = createScheduledDependencies({ admin: admin.client, userId: USER_A, deadline: Date.now() + 60_000 });
  const results: Record<string, unknown> = {};
  const run = async () => {
    const n = deps.notifications;
    results.preferences = await n.loadPreferences();
    results.planner = await n.loadPlannerData(EVENING);
    await n.claim({ kind: "tomorrow_tasks", dedupeKey: "tomorrow_tasks:2026-10-09", scheduledFor: new Date(EVENING).toISOString(), eventId: null } as unknown as PlannedNotification);
    await n.finish("d1", "sent", null);
    results.subscriptions = await n.delivery.loadSubscriptions();
    await n.delivery.removeSubscription("sb"); // another user's device id: must not be removed
    await n.delivery.removeSubscription("sa");

    const c = deps.canvas;
    await c.state.claim("automatic", 300);
    await c.state.finish("lease", { result: "success", errorCode: null, nextEligibleSeconds: 1800, courses: 0, imported: 0, updated: 0, unchanged: 0, ignored: 0, skipped: 0, review: 0 });
    const sync = c.createSync();
    await sync.loadLinks();
    await sync.loadProjectNames();
    await sync.loadPreferences();
    await sync.loadExistingExternalIds();
    await sync.upsertCourseTasks("123", []);

    const g = deps.google;
    await g.loadMetadata();
    await g.state.claim("automatic", 300);
    await g.state.finish("lease", { result: "success", nextEligibleSeconds: 900, created: 0, updated: 0, imported: 0, deleted: 0, unchanged: 0, failed: 0 });
    const google = g.createSync();
    const connection = google.connection.store;
    await connection.loadCredentials();
    await connection.saveAccessToken({ accessCiphertext: "x", accessExpiresAt: new Date(EVENING).toISOString() });
    await connection.markRevoked();
    results.interactiveOnly = [
      await connection.saveConnection({ accountEmail: null, refreshCiphertext: "r", accessCiphertext: "a", accessExpiresAt: "t", keepSelection: true }),
      await connection.saveSelectedCalendar("c", "n"),
      await connection.deleteConnection(),
    ];
    results.googleUser = google.connection.userId;
    const store = google.store;
    await store.loadLinks();
    results.events = await store.loadEvents({ from: "2026-10-01", to: "2026-12-31" }, ["eb"]);
    results.tasks = await store.loadTasks({ from: "2026-10-01", to: "2026-12-31" }, ["tb"]);
    await store.loadImported();
    await store.loadProjectNames();
    await store.insertLink({ calendarId: "c", eventId: "e", itemType: "task", localId: "ta", hash: "h" });
    await store.updateLink("lb", { hash: "x" }); // another user's link id: must not change
    await store.deleteLink("lb");
    await store.upsertImported("c", []);
  };
  return { admin, deps, results, run };
}

describe("scheduled stores: explicit user scope for every engine", () => {
  it("every select, update, delete, insert and function call of all three engines is pinned to the target user", async () => {
    const world = storeSweep();
    await world.run();
    const kinds = new Set(world.admin.operations.map((operation) => operation.kind));
    assert.deepEqual([...kinds].sort(), ["delete", "insert", "rpc", "select", "update"]);
    for (const operation of world.admin.operations) {
      const label = JSON.stringify(operation);
      if (operation.kind === "rpc") {
        assert.match(operation.fn, /^scheduler_/, label);
        assert.equal(operation.args.p_user_id, USER_A, label);
      } else if (operation.kind === "insert") {
        assert.equal(operation.values.user_id, USER_A, label);
      } else {
        assert.ok(operation.filters.some((filter) => filter.column === "user_id" && filter.op === "eq" && filter.value === USER_A), label);
      }
      assert.ok(!label.includes(USER_B), `never another user: ${label}`);
    }
    const rpcs = world.admin.operations.filter((operation) => operation.kind === "rpc").map((operation) => (operation as { fn: string }).fn);
    assert.deepEqual(rpcs.sort(), [
      "scheduler_claim_canvas_sync",
      "scheduler_claim_google_calendar_sync",
      "scheduler_claim_notification_delivery",
      "scheduler_finish_canvas_sync",
      "scheduler_finish_google_calendar_sync",
      "scheduler_finish_notification_delivery",
      "scheduler_get_google_calendar_credentials",
      "scheduler_sync_canvas_course_tasks",
      "scheduler_sync_google_calendar_events",
    ]);
  });

  it("user A's scheduled run cannot read or change user B's data", async () => {
    const world = storeSweep();
    await world.run();
    const { results, admin } = world;
    assert.deepEqual((results.planner as { tasks: { id: string }[] }).tasks.map((task) => task.id), ["ta"]);
    assert.deepEqual((results.planner as { events: { id: string }[] }).events.map((event) => event.id), ["ea"]);
    assert.deepEqual((results.subscriptions as { id: string }[]).map((subscription) => subscription.id), ["sa"]);
    assert.deepEqual((results.events as { id: string }[]).map((event) => event.id), ["ea"], "B's event id asked for explicitly is still invisible");
    assert.deepEqual((results.tasks as { id: string }[]).map((task) => task.id), ["ta"]);
    assert.deepEqual(admin.tables.push_subscriptions.map((subscription) => subscription.id), ["sb"], "only A's device was removed");
    assert.deepEqual(admin.tables.google_calendar_item_links.find((link) => link.id === "lb"), { id: "lb", user_id: USER_B, content_hash: "b" });
    assert.equal(results.googleUser, USER_A, "tokens are decrypted with the target user as context");
    assert.deepEqual(results.interactiveOnly, [false, false, false], "connecting / choosing / disconnecting stay interactive-only");
  });

  it("candidate queries are the only source of target users; the endpoint never reads one from the request", async () => {
    for (const file of schedulerSources()) {
      if (file === "lib/scheduler/deps.ts" || file === "lib/scheduler/scoped-deps.ts") continue;
      assert.doesNotMatch(code(file), /createScheduledDependencies\(/, file);
    }
    assert.match(code("lib/scheduler/deps.ts"), /const forUser = \(userId: string\) => createScheduledDependencies\(\{ admin, userId, deadline \}\)/);
    const route = code("app/api/internal/scheduler/route.ts");
    assert.doesNotMatch(route, /userId|user_id|searchParams|request\.(json|text|formData|body)|cookies/);
    const seen: string[] = [];
    const deps: SchedulerDeps = {
      now: () => 0,
      notifications: { candidates: async () => ({ kind: "ok", checked: 1, due: [USER_A] }), run: async (userId) => (seen.push(userId), { outcome: "done", planned: 0, sent: 0, skipped: 0, failed: 0, duplicates: 0 }) },
      canvas: { candidate: async () => ({ kind: "due", userId: USER_A }), run: async (userId) => (seen.push(userId), { outcome: "not_due" } as LeasedSyncResult) },
      google: { candidates: async () => ({ kind: "ok", checked: 1, due: [USER_A] }), run: async (userId) => (seen.push(userId), { outcome: "not_due" }) },
    };
    await runScheduler(deps);
    assert.deepEqual(seen, [USER_A, USER_A, USER_A]);
  });
});

// ---------------------------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------------------------

describe("scheduler policy", () => {
  const now = Date.parse("2026-10-08T10:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("sync due: no state; lease expired and cooldown passed; or reconnected after the last run", () => {
    assert.equal(isSyncDue(null, now), true);
    assert.equal(isSyncDue({ lease_until: null, next_eligible_at: iso(now - 1) }, now), true);
    assert.equal(isSyncDue({ lease_until: iso(now + MIN), next_eligible_at: null }, now), false, "active lease");
    assert.equal(isSyncDue({ lease_until: iso(now - MIN), next_eligible_at: null }, now), true, "expired lease");
    assert.equal(isSyncDue({ lease_until: null, next_eligible_at: iso(now + MIN) }, now), false, "cooldown");
    const state = { lease_until: null, next_eligible_at: iso(now + 6 * 60 * MIN), last_finished_at: iso(now - 10 * MIN) };
    assert.equal(isSyncDue(state, now, iso(now - 20 * MIN)), false);
    assert.equal(isSyncDue(state, now, iso(now - 5 * MIN)), true, "reconnected after the failed run");
  });

  it("delivery open: mirrors claim_notification_delivery", () => {
    const row = (status: string, extra: Partial<{ failure_code: string | null; attempts: number; updated_at: string }> = {}) => ({
      dedupe_key: "tomorrow_tasks:2026-10-09",
      status,
      failure_code: null,
      attempts: 1,
      updated_at: iso(now),
      ...extra,
    });
    assert.equal(isDeliveryOpen(null, now), true);
    assert.equal(isDeliveryOpen(row("sent"), now), false);
    assert.equal(isDeliveryOpen(row("skipped"), now), false);
    assert.equal(isDeliveryOpen(row("failed", { failure_code: "temporary_error" }), now), true);
    assert.equal(isDeliveryOpen(row("failed", { failure_code: "temporary_error", attempts: 3 }), now), false);
    assert.equal(isDeliveryOpen(row("failed", { failure_code: "push_rejected" }), now), false);
    assert.equal(isDeliveryOpen(row("pending"), now), false, "another run is sending it");
    assert.equal(isDeliveryOpen(row("pending", { updated_at: iso(now - 11 * MIN) }), now), true, "stale pending");
  });

  it("Canvas owner: none, exactly one, or refused for several users", () => {
    assert.deepEqual(canvasOwner(null, false), { kind: "none" });
    assert.deepEqual(canvasOwner(USER_A, false), { kind: "single", userId: USER_A });
    assert.deepEqual(canvasOwner(USER_A, true), { kind: "multiple" });
  });

  it("distinct users are bounded", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ user_id: `u${i % 15}` }));
    const result = distinctUsers(rows, SCHEDULER_MAX_USERS);
    assert.equal(result.userIds.length, SCHEDULER_MAX_USERS);
    assert.equal(result.truncated, true);
    assert.deepEqual(distinctUsers([{ user_id: "a" }, { user_id: "a" }]), { userIds: ["a"], truncated: false });
  });

  it("wakes every 5 minutes; the migration schedules exactly that", () => {
    assert.equal(SCHEDULER_CRON_SCHEDULE, "*/5 * * * *");
    const migration = files(path.join(ROOT, "supabase", "migrations"), (f) => f.endsWith("_scheduler_cron.sql"));
    assert.equal(migration.length, 1);
    assert.match(readFileSync(migration[0], "utf8"), /cron\.schedule\('traza-scheduler', '\*\/5 \* \* \* \*'/);
  });
});

// ---------------------------------------------------------------------------------------------
// Candidate queries (privileged, read-only)
// ---------------------------------------------------------------------------------------------

// 21:30 in the Canaries (UTC+1 in October before the DST change): "tomorrow" reminders are due.
const EVENING = Date.parse("2026-10-08T20:30:00Z");

function notificationTables(extra: { deliveries?: Record<string, unknown>[]; preferences?: Record<string, unknown>[] } = {}) {
  return {
    push_subscriptions: [
      { user_id: USER_A, endpoint: "https://push.example.com/SECRET-ENDPOINT-A", p256dh: "SECRET-P256DH", auth: "SECRET-AUTH", created_at: "2026-10-01" },
      { user_id: USER_A, endpoint: "https://push.example.com/SECRET-ENDPOINT-A2", p256dh: "SECRET-P256DH", auth: "SECRET-AUTH", created_at: "2026-10-02" },
    ],
    notification_preferences: extra.preferences ?? [],
    tasks: [
      { id: "t1", user_id: USER_A, title: "Entrega privada de estructuras", status: "pending", due_date: "2026-10-09" },
      { id: "t2", user_id: USER_B, title: "Tarea de otra persona", status: "pending", due_date: "2026-10-09" },
    ],
    calendar_events: [],
    notification_deliveries: extra.deliveries ?? [],
  };
}

describe("candidates: reminders", () => {
  it("a user with a device and a reminder that can still be sent is due", async () => {
    const admin = fakeAdmin(notificationTables());
    assert.deepEqual(await notificationCandidates(admin.client, EVENING), { kind: "ok", checked: 1, due: [USER_A] });
  });

  it("already sent, being sent, or out of attempts: not due; a temporary failure or a stale pending one: due", async () => {
    const delivery = (values: Record<string, unknown>) => ({ user_id: USER_A, dedupe_key: "tomorrow_tasks:2026-10-09", failure_code: null, attempts: 1, updated_at: new Date(EVENING).toISOString(), ...values });
    const cases: [Record<string, unknown>, boolean][] = [
      [{ status: "sent" }, false],
      [{ status: "skipped" }, false],
      [{ status: "pending" }, false],
      [{ status: "failed", failure_code: "temporary_error", attempts: 3 }, false],
      [{ status: "failed", failure_code: "temporary_error" }, true],
      [{ status: "pending", updated_at: new Date(EVENING - 11 * MIN).toISOString() }, true],
    ];
    for (const [values, due] of cases) {
      const admin = fakeAdmin(notificationTables({ deliveries: [delivery(values)] }));
      const result = await notificationCandidates(admin.client, EVENING);
      assert.deepEqual(result, { kind: "ok", checked: 1, due: due ? [USER_A] : [] }, JSON.stringify(values));
    }
  });

  it("disabled notifications or nothing planned: not due (the planner decides, not the wake-up)", async () => {
    const disabled = fakeAdmin(notificationTables({ preferences: [{ user_id: USER_A, push_enabled: false, tomorrow_tasks: true, morning_summary: false, event_reminders: true, event_lead_minutes: 60, show_details: false }] }));
    assert.deepEqual(await notificationCandidates(disabled.client, EVENING), { kind: "ok", checked: 1, due: [] });
    const morning = fakeAdmin(notificationTables());
    assert.deepEqual(await notificationCandidates(morning.client, Date.parse("2026-10-08T09:00:00Z")), { kind: "ok", checked: 1, due: [] });
  });

  it("users without devices are never considered; without VAPID nothing is queried", async () => {
    const admin = fakeAdmin({ ...notificationTables(), push_subscriptions: [] });
    assert.deepEqual(await notificationCandidates(admin.client, EVENING), { kind: "ok", checked: 0, due: [] });
    const saved = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    const unconfigured = fakeAdmin(notificationTables());
    assert.deepEqual(await notificationCandidates(unconfigured.client, EVENING), { kind: "not_configured" });
    assert.equal(unconfigured.selects.length, 0);
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = saved;
  });

  it("bounded fan-out, user-scoped reads, and never an endpoint or key", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ user_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, endpoint: "https://push.example.com/x", created_at: `2026-10-${String(i + 1).padStart(2, "0")}` }));
    const admin = fakeAdmin({ ...notificationTables(), push_subscriptions: many });
    const result = await notificationCandidates(admin.client, EVENING);
    assert.equal(result.kind === "ok" && result.checked, SCHEDULER_MAX_USERS);
    for (const select of admin.selects) assert.doesNotMatch(select.columns, /endpoint|p256dh|auth\b/, select.table);
    admin.failing.add("push_subscriptions");
    assert.deepEqual(await notificationCandidates(admin.client, EVENING), { kind: "unavailable" });
  });
});

describe("candidates: Canvas (one server-wide token → one user)", () => {
  const link = (userId: string) => ({ user_id: userId, canvas_course_id: "123", state: "linked", project_id: "p1" });

  it("no links: nothing to do; one user: due when the state allows it", async () => {
    assert.deepEqual(await canvasCandidate(fakeAdmin({ canvas_course_links: [] }).client, EVENING), { kind: "no_users" });
    const admin = fakeAdmin({ canvas_course_links: [link(USER_A), link(USER_A)], canvas_sync_state: [] });
    assert.deepEqual(await canvasCandidate(admin.client, EVENING), { kind: "due", userId: USER_A });
  });

  it("active lease or cooldown: not due (no session is opened, Canvas is not called)", async () => {
    for (const state of [
      { user_id: USER_A, lease_until: new Date(EVENING + MIN).toISOString(), next_eligible_at: null },
      { user_id: USER_A, lease_until: null, next_eligible_at: new Date(EVENING + 10 * MIN).toISOString() },
    ]) {
      const admin = fakeAdmin({ canvas_course_links: [link(USER_A)], canvas_sync_state: [state] });
      assert.deepEqual(await canvasCandidate(admin.client, EVENING), { kind: "not_due" });
    }
  });

  it("more than one TRAZA user with Canvas links: scheduled Canvas sync is REFUSED, whoever comes first", async () => {
    for (const rows of [[link(USER_A), link(USER_B)], [link(USER_B), link(USER_A), link(USER_A)]]) {
      const admin = fakeAdmin({ canvas_course_links: rows, canvas_sync_state: [] });
      assert.deepEqual(await canvasCandidate(admin.client, EVENING), { kind: "multiple_users" });
      assert.ok(!admin.selects.some((select) => select.table === "canvas_sync_state"));
    }
  });

  it("without the Canvas configuration nothing is queried", async () => {
    const saved = process.env.CANVAS_ACCESS_TOKEN;
    delete process.env.CANVAS_ACCESS_TOKEN;
    const admin = fakeAdmin({ canvas_course_links: [link(USER_A)] });
    assert.deepEqual(await canvasCandidate(admin.client, EVENING), { kind: "not_configured" });
    assert.equal(admin.selects.length, 0);
    process.env.CANVAS_ACCESS_TOKEN = saved;
  });
});

describe("candidates: Google", () => {
  const connection = (userId: string, values: Record<string, unknown> = {}) => ({
    user_id: userId,
    status: "connected",
    selected_calendar_id: "cal@group.calendar.google.com",
    connected_at: "2026-10-01T10:00:00Z",
    refresh_token_ciphertext: "SECRET-CIPHERTEXT",
    access_token_ciphertext: "SECRET-CIPHERTEXT",
    ...values,
  });

  it("only real connections with a chosen calendar, and only when their state is due", async () => {
    const admin = fakeAdmin({
      google_calendar_connections: [
        connection(USER_A),
        connection(USER_B, { status: "revoked" }),
        connection("00000000-0000-4000-8000-0000000000cc", { selected_calendar_id: null }),
        connection("00000000-0000-4000-8000-0000000000dd"),
      ],
      google_calendar_sync_state: [{ user_id: "00000000-0000-4000-8000-0000000000dd", lease_until: null, next_eligible_at: new Date(EVENING + MIN).toISOString(), last_finished_at: new Date(EVENING - MIN).toISOString() }],
    });
    assert.deepEqual(await googleCandidates(admin.client, EVENING), { kind: "ok", checked: 2, due: [USER_A] });
    for (const select of admin.selects) assert.doesNotMatch(select.columns, /ciphertext|token/, select.table);
  });

  it("a reconnection after a failed run makes it due again despite the long backoff", async () => {
    const admin = fakeAdmin({
      google_calendar_connections: [connection(USER_A, { connected_at: new Date(EVENING - MIN).toISOString() })],
      google_calendar_sync_state: [{ user_id: USER_A, lease_until: null, next_eligible_at: new Date(EVENING + 5 * 60 * MIN).toISOString(), last_finished_at: new Date(EVENING - 30 * MIN).toISOString() }],
    });
    assert.deepEqual(await googleCandidates(admin.client, EVENING), { kind: "ok", checked: 1, due: [USER_A] });
  });

  it("bounded, and nothing is queried without the Google configuration", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => connection(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
    const admin = fakeAdmin({ google_calendar_connections: rows, google_calendar_sync_state: [] });
    const result = await googleCandidates(admin.client, EVENING);
    assert.equal(result.kind === "ok" && result.checked, SCHEDULER_MAX_USERS);
    process.env.VERCEL_ENV = "production"; // the localhost callback is refused on a production deployment
    const unconfigured = fakeAdmin({ google_calendar_connections: rows });
    assert.deepEqual(await googleCandidates(unconfigured.client, EVENING), { kind: "not_configured" });
    assert.equal(unconfigured.selects.length, 0);
    delete process.env.VERCEL_ENV;
  });
});

// ---------------------------------------------------------------------------------------------
// Orchestration: independence, budget, safe output
// ---------------------------------------------------------------------------------------------

function fakeDeps(overrides: Partial<{ [K in keyof SchedulerDeps]: Partial<SchedulerDeps[K]> }> = {}, clock = { now: 0 }) {
  const ran: string[] = [];
  const deps: SchedulerDeps = {
    now: () => clock.now,
    notifications: {
      candidates: async () => ({ kind: "ok", checked: 1, due: [USER_A] }),
      run: async (userId) => (ran.push(`n:${userId}`), { outcome: "done", planned: 1, sent: 1, skipped: 0, failed: 0, duplicates: 0 }),
      ...overrides.notifications,
    },
    canvas: {
      candidate: async () => ({ kind: "due", userId: USER_A }),
      run: async (userId) => (ran.push(`c:${userId}`), { outcome: "success" } as LeasedSyncResult),
      ...overrides.canvas,
    },
    google: {
      candidates: async () => ({ kind: "ok", checked: 2, due: [USER_A, USER_B] }),
      run: async (userId) => (ran.push(`g:${userId}`), { outcome: "success" }),
      ...overrides.google,
    },
  };
  return { deps, ran };
}

const SAFE_KEYS = {
  top: ["canvas", "durationMs", "google", "notifications", "ok", "outcome"],
  notifications: ["deferred", "deliveriesAttempted", "outcome", "sent", "usersChecked", "usersRun"],
  canvas: ["outcome"],
  google: ["deferred", "failed", "outcome", "skipped", "successful", "usersChecked"],
};

function assertSafe(result: SchedulerResult) {
  assert.deepEqual(Object.keys(result).sort(), SAFE_KEYS.top);
  assert.deepEqual(Object.keys(result.notifications).sort(), SAFE_KEYS.notifications);
  assert.deepEqual(Object.keys(result.canvas).sort(), SAFE_KEYS.canvas);
  assert.deepEqual(Object.keys(result.google).sort(), SAFE_KEYS.google);
  for (const text of [JSON.stringify(result), schedulerLogLine(result)]) {
    for (const secret of [USER_A, USER_B, SECRET, "SECRET", "Entrega privada", "@", "https://"]) assert.ok(!text.includes(secret), secret);
  }
}

describe("scheduler orchestration", () => {
  it("runs the three lanes and returns aggregate counts only", async () => {
    const { deps, ran } = fakeDeps();
    const result = await runScheduler(deps);
    assert.equal(result.outcome, "success");
    assert.deepEqual(result.notifications, { outcome: "done", usersChecked: 1, usersRun: 1, deferred: 0, deliveriesAttempted: 1, sent: 1 });
    assert.deepEqual(result.canvas, { outcome: "success" });
    assert.deepEqual(result.google, { outcome: "done", usersChecked: 2, successful: 2, skipped: 0, failed: 0, deferred: 0 });
    assert.deepEqual(ran.sort(), [`c:${USER_A}`, `g:${USER_A}`, `g:${USER_B}`, `n:${USER_A}`].sort());
    assertSafe(result);
    assert.match(schedulerLogLine(result), /^TRAZA scheduler: outcome=success notifications=1 notifications_lane=done canvas=success google=2 google_lane=done duration=\d+ms$/);
  });

  it("a Canvas failure does not stop reminders or Google", async () => {
    const { deps, ran } = fakeDeps({ canvas: { candidate: async () => Promise.reject(new Error("Canvas exploded with SECRET details")) } });
    const result = await runScheduler(deps);
    assert.equal(result.outcome, "partial");
    assert.equal(result.canvas.outcome, "error");
    assert.equal(result.notifications.sent, 1);
    assert.equal(result.google.successful, 2);
    assert.ok(ran.includes(`n:${USER_A}`) && ran.includes(`g:${USER_B}`));
    assertSafe(result);
  });

  it("a Google failure (lane or one user) does not stop Canvas, reminders, or the next Google user", async () => {
    const oneUser = fakeDeps({
      google: { run: async (userId) => (userId === USER_A ? Promise.reject(new Error("Google 500 SECRET")) : { outcome: "success" }) },
    });
    const result = await runScheduler(oneUser.deps);
    assert.deepEqual([result.google.successful, result.google.failed], [1, 1]);
    assert.equal(result.outcome, "success");
    const lane = fakeDeps({ google: { candidates: async () => Promise.reject(new Error("db down")) } });
    const laneResult = await runScheduler(lane.deps);
    assert.equal(laneResult.google.outcome, "error");
    assert.equal(laneResult.canvas.outcome, "success");
    assert.equal(laneResult.notifications.sent, 1);
    assertSafe(laneResult);
  });

  it("a reminder failure does not stop Canvas or Google", async () => {
    const { deps } = fakeDeps({ notifications: { candidates: async () => Promise.reject(new Error("push down")) } });
    const result = await runScheduler(deps);
    assert.equal(result.notifications.outcome, "error");
    assert.equal(result.canvas.outcome, "success");
    assert.equal(result.google.successful, 2);
  });

  it("not due, not configured, several Canvas users, or no session: no engine runs for that lane", async () => {
    for (const kind of ["not_due", "not_configured", "multiple_users", "no_users", "unavailable"] as const) {
      const { deps, ran } = fakeDeps({ canvas: { candidate: async () => ({ kind }) } });
      const result = await runScheduler(deps);
      assert.equal(result.canvas.outcome, kind);
      assert.ok(!ran.some((entry) => entry.startsWith("c:")), kind);
    }
  });

  it("past the new-work budget no user is started; the rest is left for a later wake-up", async () => {
    const clock = { now: 0 };
    const users = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const { deps, ran } = fakeDeps(
      {
        notifications: {
          candidates: async () => ({ kind: "ok", checked: 5, due: users }),
          run: async (userId) => {
            ran.push(`n:${userId}`);
            clock.now += SCHEDULER_NEW_WORK_MS / 2; // each user takes half the budget
            return { outcome: "done", planned: 1, sent: 1, skipped: 0, failed: 0, duplicates: 0 };
          },
        },
        canvas: {
          candidate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { kind: "due", userId: USER_A };
          },
        },
        google: { candidates: async () => ({ kind: "ok", checked: 0, due: [] }) },
      },
      clock,
    );
    const result = await runScheduler(deps);
    assert.equal(ran.filter((entry) => entry.startsWith("n:")).length, 2);
    assert.equal(result.notifications.deferred, 3);
    assert.equal(result.canvas.outcome, "deferred");
    assert.ok(!ran.some((entry) => entry.startsWith("c:")));
  });

  it("the real wiring uses the existing engines with the automatic trigger and a bounded deadline", () => {
    const source = code("lib/scheduler/deps.ts");
    // The same engines as the interactive paths (no second reconciliation implementation).
    assert.match(source, /runDueNotifications\(forUser\(userId\)\.notifications\)/);
    assert.match(source, /runLeasedCanvasSync\(forUser\(userId\)\.canvas, "automatic"\)/);
    assert.match(source, /runLeasedGoogleSync\(forUser\(userId\)\.google, "automatic"\)/);
    assert.match(source, /SCHEDULER_HARD_DEADLINE_MS/);
    assert.doesNotMatch(source, /"manual"/);
    assert.match(code("lib/scheduler/stores/google.ts"), /keepUnreadableCredentials: true/, "automatic behaviour: never wipes undecryptable credentials");
    // The deadline can only shorten the engines' own deadlines.
    assert.match(code("lib/scheduler/stores/canvas.ts"), /Math\.min\(Date\.now\(\) \+ CANVAS_SYNC_DEADLINE_MS, options\.deadline\)/);
    assert.match(code("lib/scheduler/stores/google.ts"), /Math\.min\(Date\.now\(\) \+ GOOGLE_SYNC_DEADLINE_MS, options\.deadline\)/);
    // No in-memory global lock: the database leases and dedupe are the concurrency control.
    for (const file of schedulerSources()) assert.doesNotMatch(code(file), /mutex|let running|isRunning|globalThis/i, file);
  });
});

// ---------------------------------------------------------------------------------------------
// Reminders through the real planner + run, repeated wake-ups
// ---------------------------------------------------------------------------------------------

function reminderWorld(options: { preferences?: Partial<NotificationPreferences>; tasks?: PlannerTask[]; events?: PlannerEvent[]; expire?: string[] } = {}) {
  let clock = EVENING;
  const deliveries = new Map<string, { id: string; status: string; failure_code: string | null; attempts: number; updated_at: number }>();
  const subscriptions: StoredSubscription[] = [
    { id: "s1", endpoint: "https://push.example.com/phone", p256dh: "k1", auth: "a1" },
    { id: "s2", endpoint: "https://push.example.com/laptop", p256dh: "k2", auth: "a2" },
  ];
  const payloads: { device: string; payload: string }[] = [];
  let ids = 0;
  const deps = (): NotificationRunDeps => ({
    configured: true,
    loadPreferences: async () => ({ ...DEFAULT_PREFERENCES, ...options.preferences }),
    loadPlannerData: async () => ({ tasks: options.tasks ?? [{ id: "t1", title: "Entrega privada de estructuras", status: "pending", due_date: "2026-10-09" }], events: options.events ?? [] }),
    // Mirrors claim_notification_delivery (unique per key; bounded re-claims).
    claim: async (planned: PlannedNotification) => {
      const row = deliveries.get(planned.dedupeKey);
      if (!row) {
        const id = `d${++ids}`;
        deliveries.set(planned.dedupeKey, { id, status: "pending", failure_code: null, attempts: 1, updated_at: clock });
        return id;
      }
      const reclaim = row.attempts < 3 && ((row.status === "failed" && row.failure_code === "temporary_error") || (row.status === "pending" && row.updated_at < clock - 10 * MIN));
      if (!reclaim) return null;
      Object.assign(row, { status: "pending", failure_code: null, attempts: row.attempts + 1, updated_at: clock });
      return row.id;
    },
    finish: async (id: string, status: DeliveryStatus, code: string | null) => {
      const row = [...deliveries.values()].find((entry) => entry.id === id);
      if (!row) return false;
      Object.assign(row, { status, failure_code: code, updated_at: clock });
      return true;
    },
    delivery: {
      loadSubscriptions: async () => [...subscriptions],
      removeSubscription: async (id: string) => {
        const index = subscriptions.findIndex((subscription) => subscription.id === id);
        if (index >= 0) subscriptions.splice(index, 1);
        return true;
      },
      send: async (subscription, payload) => {
        if (options.expire?.includes(subscription.id)) return { ok: false, code: "expired_subscription" };
        payloads.push({ device: subscription.id, payload });
        return { ok: true };
      },
    },
    now: () => clock,
  });
  const schedulerDeps = (): SchedulerDeps => ({
    now: () => clock,
    // The wake-up claims "due" every time on purpose: only the planner + dedupe may decide.
    notifications: { candidates: async () => ({ kind: "ok", checked: 1, due: [USER_A] }), run: () => runDueNotifications(deps()) },
    canvas: { candidate: async () => ({ kind: "not_due" }), run: unexpected },
    google: { candidates: async () => ({ kind: "ok", checked: 0, due: [] }), run: unexpected },
  });
  return { deliveries, subscriptions, payloads, schedulerDeps, deps, advance: (ms: number) => (clock += ms) };
}

describe("scheduled reminders (existing planner, preferences, dedupe and delivery)", () => {
  it("repeated wake-ups every 5 minutes send each reminder exactly once", async () => {
    const w = reminderWorld();
    const sentCounts: number[] = [];
    for (let i = 0; i < 6; i++) {
      sentCounts.push((await runScheduler(w.schedulerDeps())).notifications.sent);
      w.advance(5 * MIN);
    }
    assert.deepEqual(sentCounts, [1, 0, 0, 0, 0, 0]);
    assert.equal(w.payloads.length, 2, "one reminder, delivered to both devices");
    assert.deepEqual([...w.deliveries.keys()], ["tomorrow_tasks:2026-10-09"]);
  });

  it("the browser check and the scheduler share the same dedupe: whichever runs second sends nothing", async () => {
    const w = reminderWorld();
    const browser = await runDueNotifications(w.deps());
    const scheduled = await runScheduler(w.schedulerDeps());
    assert.equal(browser.sent, 1);
    assert.equal(scheduled.notifications.sent, 0);
    assert.equal(w.payloads.length, 2);
  });

  it("privacy unchanged: by default no titles leave the server; show_details only adds short titles", async () => {
    const w = reminderWorld();
    await runScheduler(w.schedulerDeps());
    for (const { payload } of w.payloads) {
      assert.ok(!payload.includes("Entrega privada"), payload);
      assert.match(JSON.parse(payload).body, /^Tienes 1 tarea para mañana\.$/);
    }
    const detailed = reminderWorld({ preferences: { showDetails: true } });
    await runScheduler(detailed.schedulerDeps());
    assert.match(JSON.parse(detailed.payloads[0].payload).body, /Entrega privada de estructuras/);
  });

  it("disabled notifications: nothing is claimed or sent", async () => {
    const w = reminderWorld({ preferences: { pushEnabled: false } });
    const result = await runScheduler(w.schedulerDeps());
    assert.equal(result.notifications.sent, 0);
    assert.equal(w.deliveries.size, 0);
  });

  it("the planner stays the authority: a wake-up outside any reminder window sends nothing", async () => {
    const w = reminderWorld();
    w.advance(-11 * 60 * MIN); // 10:30 in the Canaries; the morning summary is off by default
    const result = await runScheduler(w.schedulerDeps());
    assert.equal(result.notifications.sent, 0);
    assert.equal(w.deliveries.size, 0);
  });

  it("an expired device is removed (only that one) and the other still receives it", async () => {
    const w = reminderWorld({ expire: ["s1"] });
    const result = await runScheduler(w.schedulerDeps());
    assert.equal(result.notifications.sent, 1);
    assert.deepEqual(w.subscriptions.map((subscription) => subscription.id), ["s2"]);
    assert.deepEqual(w.payloads.map((entry) => entry.device), ["s2"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Canvas through the real leased engine: overlaps with the browser and manual sync
// ---------------------------------------------------------------------------------------------

function canvasWorld() {
  let clock = EVENING;
  const state = { lease: null as string | null, leaseUntil: 0, nextEligible: 0, leases: 0 };
  let enginesStarted = 0;
  /** Mirrors claim_canvas_sync / finish_canvas_sync. */
  const store: SyncStateStore = {
    async claim(trigger, leaseSeconds): Promise<SyncClaim | null> {
      if (state.lease && state.leaseUntil > clock) return { claimed: false, reason: "already_running", leaseToken: null, consecutiveFailures: 0 };
      if (trigger === "automatic" && state.nextEligible > clock) return { claimed: false, reason: "not_due", leaseToken: null, consecutiveFailures: 0 };
      state.lease = `lease-${++state.leases}`;
      state.leaseUntil = clock + leaseSeconds * 1000;
      return { claimed: true, reason: "claimed", leaseToken: state.lease, consecutiveFailures: 0 };
    },
    async finish(token, record: SyncRecord) {
      if (state.lease !== token) return false;
      state.lease = null;
      state.nextEligible = clock + record.nextEligibleSeconds * 1000;
      return true;
    },
  };
  let release: () => void = () => {};
  let hold = false;
  const run = (trigger: "automatic" | "manual") =>
    runLeasedCanvasSync(
      {
        state: store,
        createSync: () => {
          enginesStarted++;
          return {
            // Linked courses exist but this fake returns none to read: the engine stops before Canvas.
            loadLinks: async () => {
              if (hold) await new Promise<void>((resolve) => (release = resolve));
              return { ok: true, links: [] };
            },
          } as unknown as SyncDeps;
        },
        now: () => clock,
      },
      trigger,
    );
  return {
    run,
    engines: () => enginesStarted,
    hold: () => (hold = true),
    release: () => {
      hold = false;
      release();
    },
    advance: (ms: number) => (clock += ms),
    schedulerDeps: (): SchedulerDeps => ({
      now: () => clock,
      notifications: { candidates: async () => ({ kind: "ok", checked: 0, due: [] }), run: unexpected },
      canvas: { candidate: async () => ({ kind: "due", userId: USER_A }), run: () => run("automatic") },
      google: { candidates: async () => ({ kind: "ok", checked: 0, due: [] }), run: unexpected },
    }),
  };
}

describe("scheduled Canvas sync (existing lease and cooldown)", () => {
  it("a due run syncs; the next wake-ups inside the 30-minute cooldown return not_due without touching Canvas", async () => {
    const w = canvasWorld();
    assert.equal((await runScheduler(w.schedulerDeps())).canvas.outcome, "no_linked_courses");
    for (let i = 0; i < 5; i++) {
      w.advance(5 * MIN);
      assert.equal((await runScheduler(w.schedulerDeps())).canvas.outcome, "not_due");
    }
    assert.equal(w.engines(), 1);
    w.advance(AUTO_SYNC_COOLDOWN_SECONDS * 1000);
    await runScheduler(w.schedulerDeps());
    assert.equal(w.engines(), 2);
  });

  it("browser auto-sync or manual sync in progress: the scheduler's run is refused by the lease (one engine)", async () => {
    for (const trigger of ["automatic", "manual"] as const) {
      const w = canvasWorld();
      w.hold();
      const first = w.run(trigger);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const scheduled = await runScheduler(w.schedulerDeps());
      assert.equal(scheduled.canvas.outcome, "already_running", trigger);
      w.release();
      await first;
      assert.equal(w.engines(), 1, trigger);
    }
  });

  it("a scheduler run in progress refuses the browser's run as well", async () => {
    const w = canvasWorld();
    w.hold();
    const scheduled = runScheduler(w.schedulerDeps());
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal((await w.run("automatic")).outcome, "already_running");
    w.release();
    await scheduled;
    assert.equal(w.engines(), 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Google through the real leased engine on the fake Google server
// ---------------------------------------------------------------------------------------------

function googleWorld(options: Parameters<typeof setup>[0] = {}) {
  const base = setup(options);
  let clock = GOOGLE_NOW;
  const s = { lease: null as string | null, leaseUntil: 0, nextEligible: 0, leases: 0, failures: 0 };
  let engines = 0;
  const state = {
    async claim(trigger: GoogleSyncTrigger, leaseSeconds: number): Promise<GoogleSyncClaim | null> {
      if (s.lease && s.leaseUntil > clock) return { claimed: false, reason: "already_running", leaseToken: null, consecutiveFailures: s.failures };
      if (trigger === "automatic" && s.nextEligible > clock) return { claimed: false, reason: "not_due", leaseToken: null, consecutiveFailures: s.failures };
      s.lease = `lease-${++s.leases}`;
      s.leaseUntil = clock + leaseSeconds * 1000;
      return { claimed: true, reason: "claimed", leaseToken: s.lease, consecutiveFailures: s.failures };
    },
    async finish(token: string, record: GoogleSyncRecord) {
      if (s.lease !== token) return false;
      s.lease = null;
      s.failures = record.result === "success" ? 0 : s.failures + 1;
      s.nextEligible = clock + record.nextEligibleSeconds * 1000;
      return true;
    },
  };
  const leased = (trigger: GoogleSyncTrigger): LeasedGoogleSyncDeps => ({
    configured: true,
    loadMetadata: () => base.connection.store.loadMetadata(),
    state,
    createSync: () => {
      engines++;
      return { ...base.deps, connection: { ...base.deps.connection, now: () => clock, keepUnreadableCredentials: trigger === "automatic" } };
    },
    now: () => clock,
  });
  const run = (trigger: GoogleSyncTrigger) => runLeasedGoogleSync(leased(trigger), trigger);
  return {
    ...base,
    run,
    engines: () => engines,
    tokenCalls: () => base.google.calls.filter((call) => call.method === "TOKEN").length,
    advance: (ms: number) => (clock += ms),
    schedulerDeps: (): SchedulerDeps => ({
      now: () => clock,
      notifications: { candidates: async () => ({ kind: "ok", checked: 0, due: [] }), run: unexpected },
      canvas: { candidate: async () => ({ kind: "not_due" }), run: unexpected },
      google: { candidates: async () => ({ kind: "ok", checked: 1, due: [USER_A] }), run: () => run("automatic") },
    }),
  };
}

describe("scheduled Google sync (existing engine, lease, cooldown and token handling)", () => {
  it("a due connection syncs; wake-ups inside the 15-minute cooldown do not call Google; no duplicates over many runs", async () => {
    const w = googleWorld();
    w.traza.addEvent();
    w.google.add(independent("g1"));
    const first = await runScheduler(w.schedulerDeps());
    assert.equal(first.google.successful, 1);
    const calls = w.google.calls.length;
    w.advance(5 * MIN);
    const second = await runScheduler(w.schedulerDeps());
    assert.deepEqual([second.google.successful, second.google.failed], [0, 0]);
    assert.equal(w.google.calls.length, calls, "not due: no Google request");
    for (let i = 0; i < 6; i++) {
      w.advance(GOOGLE_AUTO_SYNC_COOLDOWN_SECONDS * 1000 + 1);
      await runScheduler(w.schedulerDeps());
    }
    const mirrors = [...w.google.events.values()].filter((event) => event.status !== "cancelled");
    assert.equal(mirrors.length, 2, "one mirror + the Google event, never duplicated");
    assert.equal(w.traza.db.events.length, 2, "the local event + one imported event");
  });

  it("an expired access token is refreshed server-side during a scheduled run", async () => {
    const w = googleWorld({ accessValidFor: 0 });
    w.traza.addEvent();
    const result = await runScheduler(w.schedulerDeps());
    assert.equal(result.google.successful, 1);
    assert.equal(w.tokenCalls(), 1);
  });

  it("invalid_grant becomes reconnect_required; the response carries no token", async () => {
    const w = googleWorld({ accessValidFor: 0 });
    w.google.state.refreshRevoked = true;
    const result = await runScheduler(w.schedulerDeps());
    assert.equal(result.google.failed, 1);
    assert.equal(w.connection.state.metadata.status, "revoked");
    for (const secret of [ACCESS, NEW_ACCESS, REFRESH, config.clientSecret]) assert.ok(!JSON.stringify(result).includes(secret));
    assertSafe(result);
  });

  it("browser, manual and scheduled runs overlapping: one engine at a time", async () => {
    const w = googleWorld();
    w.traza.addEvent();
    let release: () => void = () => {};
    let held = true;
    w.google.state.beforeRequest = () => (held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve());
    const manual = w.run("manual");
    await new Promise((resolve) => setTimeout(resolve, 1));
    const scheduled = await runScheduler(w.schedulerDeps());
    assert.deepEqual([scheduled.google.successful, scheduled.google.skipped], [0, 1], "already_running is a skip");
    held = false;
    release();
    await manual;
    assert.equal(w.engines(), 1);
  });
});
