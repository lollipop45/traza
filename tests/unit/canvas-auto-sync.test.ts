// Automatic Canvas sync, end to end below the HTTP layer: the REAL Canvas client (retries,
// Retry-After, deadline), parser, relevance rules, classifier, engine and leased runner, against a
// FAKE Canvas (scripted fetch, fake token, virtual clock) and an in-memory store that mirrors the
// SQL semantics of claim/finish_canvas_sync and sync_canvas_course_tasks (the SQL itself is tested
// in tests/db). No network, no real Canvas, no Supabase.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { canvasDueDate } from "@/lib/canvas/assignments";
import { classifySyncResult, runLeasedCanvasSync, syncLogLine, type LeasedSyncDeps, type SyncClaim, type SyncRecord } from "@/lib/canvas/auto-sync";
import { AUTO_SYNC_HEADER, autoSyncResponse, isSameOriginRequest } from "@/lib/canvas/auto-sync-request";
import { CANVAS_MAX_RETRY_AFTER_MS, type FetchLike } from "@/lib/canvas/client";
import type { CanvasCourseLink } from "@/lib/canvas/mapping";
import { readCanvasOverview, readCourseAssignments } from "@/lib/canvas/read";
import { runCanvasSync, type AssignmentPreference, type CanvasSyncResult, type SyncDeps, type UpsertOutcome } from "@/lib/canvas/sync";
import {
  AUTH_ERROR_BACKOFF_SECONDS,
  AUTO_SYNC_COOLDOWN_SECONDS,
  CANVAS_SYNC_LEASE_SECONDS,
  FAILURE_BACKOFF_SECONDS,
  canvasFailureCode,
  nextEligibleSeconds,
  type SyncTrigger,
} from "@/lib/canvas/sync-policy";
import { relativeTime, syncStatusView } from "@/lib/canvas/sync-status";

const FAKE_TOKEN = "1234~FAKEcanvasTOKENnotREAL0123456789";
const BASE = "https://campus.example.edu";
const TODAY = "2026-10-07";
const START = Date.parse("2026-10-07T09:00:00Z");
const P1 = "00000000-0000-4000-8000-0000000000p1".replace("p1", "a1");
const P2 = "00000000-0000-4000-8000-0000000000b2";
const MIN = 60_000;

type Raw = Record<string, unknown>;
/** A clearly actionable assignment (online upload, dated, published). */
const raw = (id: string, name: string, extra: Raw = {}): Raw => ({
  id,
  name,
  due_at: "2026-10-12T22:59:00Z",
  published: true,
  submission_types: ["online_upload"],
  created_at: "2026-09-20T10:00:00Z",
  ...extra,
});
const review = (id: string, name: string) => raw(id, name, { submission_types: ["none"] });
const gradebook = (id: string) => raw(id, "Notas finales AUDS", { submission_types: ["none"] });
const attendance = (id: string) => raw(id, "Roll Call Attendance", { submission_types: ["external_tool"] });

const link = (courseId: string, projectId: string | null, state: "linked" | "ignored" = "linked"): CanvasCourseLink => ({
  id: `00000000-0000-4000-8000-${courseId.padStart(12, "0")}`,
  canvas_course_id: courseId,
  project_id: projectId,
  state,
  canvas_course_name: `Curso ${courseId}`,
  canvas_course_code: null,
});

type Task = { title: string; due_date: string | null; project_id: string; priority: string; status: "pending" | "done" };
type Failure = Response | "network" | "timeout" | undefined;
type State = {
  lease_token: string | null;
  lease_until: number | null;
  next_eligible_at: number | null;
  consecutive_failures: number;
  last_result: string | null;
  last_error_code: string | null;
  last_success_at: number | null;
  record: SyncRecord | null;
};

function world() {
  let clock = START;
  let leases = 0;
  let syncsCreated = 0;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const canvas = {
    courses: [
      { id: "145580", name: "TALLER DE PROYECTOS" },
      { id: "145581", name: "DIBUJO III" },
    ],
    assignments: { "145580": [raw("7001", "Panel análisis territorial")], "145581": [] } as Record<string, Raw[]>,
    /** Scripted failure for a request (path without /api/v1/, 1-based index of requests to that path). */
    fail: undefined as ((path: string, nth: number) => Failure) | undefined,
    /** When set, the first assignments request waits for it (to hold a run "in Canvas"). */
    gate: null as Promise<void> | null,
    reachedGate: null as (() => void) | null,
  };
  const perPath = new Map<string, number>();

  const fetch: FetchLike = async (url) => {
    const pathName = new URL(url).pathname.replace(/^\/api\/v1\//, "");
    calls.push(pathName);
    const nth = (perPath.get(pathName) ?? 0) + 1;
    perPath.set(pathName, nth);
    clock += 50;
    if (canvas.gate && pathName.endsWith("/assignments")) {
      const gate = canvas.gate;
      canvas.gate = null;
      canvas.reachedGate?.();
      await gate;
    }
    const failure = canvas.fail?.(pathName, nth);
    if (failure === "network") throw new TypeError(`fetch failed ${FAKE_TOKEN}`);
    if (failure === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (failure) return failure;
    if (pathName === "users/self") return Response.json({ id: "42", name: "Hugo" });
    if (pathName === "courses") return Response.json(canvas.courses.map((c) => ({ ...c, workflow_state: "available" })));
    const match = pathName.match(/^courses\/(\d+)\/assignments$/);
    if (match) return Response.json(canvas.assignments[match[1]] ?? []);
    return new Response("not found", { status: 404 });
  };

  const db = {
    links: [link("145580", P1), link("145581", P2)],
    projects: new Map([
      [P1, "Taller de Proyectos"],
      [P2, "Dibujo III"],
    ]),
    prefs: [] as AssignmentPreference[],
    tasks: new Map<string, Task>(),
    state: null as State | null,
  };

  /** Mirrors set_canvas_assignment_preference: ignoring removes the Campus task. */
  function setPreference(courseId: string, assignmentId: string, state: "ignored" | "included") {
    db.prefs = db.prefs.filter((p) => !(p.canvas_course_id === courseId && p.canvas_assignment_id === assignmentId));
    db.prefs.push({ canvas_course_id: courseId, canvas_assignment_id: assignmentId, state });
    if (state === "ignored") db.tasks.delete(`course:${courseId}:assignment:${assignmentId}`);
  }

  /** Mirrors sync_canvas_course_tasks (field ownership, idempotency, ignored never written). */
  async function upsert(courseId: string, writes: { assignment_id: string; title: string; due_date: string | null; submitted: boolean }[]): Promise<UpsertOutcome[] | null> {
    const linkRow = db.links.find((l) => l.canvas_course_id === courseId && l.state === "linked" && l.project_id && db.projects.has(l.project_id));
    if (!linkRow?.project_id) return null; // the function raises "not linked"
    return writes.map((write) => {
      const ignored = db.prefs.some((p) => p.canvas_course_id === courseId && p.canvas_assignment_id === write.assignment_id && p.state === "ignored");
      if (ignored) return { assignment_id: write.assignment_id, outcome: "ignored" };
      const key = `course:${courseId}:assignment:${write.assignment_id}`;
      const task = db.tasks.get(key);
      if (!task) {
        db.tasks.set(key, { title: write.title, due_date: write.due_date, project_id: linkRow.project_id!, priority: "normal", status: write.submitted ? "done" : "pending" });
        return { assignment_id: write.assignment_id, outcome: "created" };
      }
      const completes = task.status === "pending" && write.submitted;
      if (task.title === write.title && task.due_date === write.due_date && task.project_id === linkRow.project_id && !completes) {
        return { assignment_id: write.assignment_id, outcome: "unchanged" };
      }
      Object.assign(task, { title: write.title, due_date: write.due_date, project_id: linkRow.project_id, status: completes ? "done" : task.status });
      return { assignment_id: write.assignment_id, outcome: "updated" };
    });
  }

  /** Mirrors claim_canvas_sync / finish_canvas_sync. */
  const state = {
    failFinish: false,
    async claim(trigger: SyncTrigger, leaseSeconds: number): Promise<SyncClaim | null> {
      db.state ??= { lease_token: null, lease_until: null, next_eligible_at: null, consecutive_failures: 0, last_result: null, last_error_code: null, last_success_at: null, record: null };
      const s = db.state;
      if (s.lease_until !== null && s.lease_until > clock) return { claimed: false, reason: "already_running", leaseToken: null, consecutiveFailures: s.consecutive_failures };
      if (trigger === "automatic" && s.next_eligible_at !== null && s.next_eligible_at > clock) {
        return { claimed: false, reason: "not_due", leaseToken: null, consecutiveFailures: s.consecutive_failures };
      }
      s.lease_token = `lease-${++leases}`;
      s.lease_until = clock + leaseSeconds * 1000;
      return { claimed: true, reason: "claimed", leaseToken: s.lease_token, consecutiveFailures: s.consecutive_failures };
    },
    async finish(token: string, record: SyncRecord): Promise<boolean> {
      if (state.failFinish) throw new Error("connection lost");
      const s = db.state;
      if (!s || s.lease_token !== token) return false;
      const success = record.result === "success" || record.result === "no_linked_courses";
      Object.assign(s, {
        lease_token: null,
        lease_until: null,
        last_result: record.result,
        last_error_code: success ? null : record.errorCode,
        last_success_at: success ? clock : s.last_success_at,
        consecutive_failures: success ? 0 : s.consecutive_failures + 1,
        next_eligible_at: clock + record.nextEligibleSeconds * 1000,
        record,
      });
      return true;
    },
  };

  const config = { ok: true as const, config: { baseUrl: BASE, token: FAKE_TOKEN } };
  const clientOptions = {
    fetch,
    retryDelayMs: 500,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    now: () => clock,
  };
  const syncDeps = (): SyncDeps => ({
    loadOverview: () => readCanvasOverview(config, clientOptions),
    loadLinks: async () => ({ ok: true, links: db.links.map((l) => ({ ...l })) }),
    loadProjectNames: async () => new Map(db.projects),
    loadAssignments: (courseId) => readCourseAssignments(config, courseId, clientOptions),
    loadPreferences: async () => db.prefs.map((p) => ({ ...p })),
    loadExistingExternalIds: async () => new Set(db.tasks.keys()),
    upsertCourseTasks: upsert,
    today: TODAY,
  });
  const leased = (): LeasedSyncDeps => ({
    state,
    createSync: () => {
      syncsCreated += 1;
      return syncDeps();
    },
    now: () => clock,
  });

  return {
    canvas,
    db,
    state,
    calls,
    sleeps,
    setPreference,
    run: (trigger: SyncTrigger = "automatic") => runLeasedCanvasSync(leased(), trigger),
    preview: () => runCanvasSync(syncDeps(), "preview"),
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    syncsCreated: () => syncsCreated,
    task: (courseId: string, assignmentId: string) => db.tasks.get(`course:${courseId}:assignment:${assignmentId}`),
  };
}

// ---------------------------------------------------------------------------

describe("auto-sync: sync state", () => {
  it("the first automatic sync is due, runs, and establishes the 30-minute cooldown", async () => {
    const w = world();
    const result = await w.run();
    assert.equal(result.outcome, "success");
    assert.equal(result.imported, 1);
    assert.equal(w.db.tasks.size, 1);
    assert.equal(w.db.state?.last_result, "success");
    assert.equal(w.db.state?.lease_until, null, "the lease is released");
    assert.equal(w.db.state!.next_eligible_at! - w.now(), AUTO_SYNC_COOLDOWN_SECONDS * 1000);
    assert.equal(AUTO_SYNC_COOLDOWN_SECONDS, 30 * 60);
  });

  it("inside the cooldown, automatic checks return not_due without calling Canvas; manual still runs", async () => {
    const w = world();
    await w.run();
    const canvasCalls = w.calls.length;
    for (let i = 0; i < 10; i++) {
      w.advance(2 * MIN);
      assert.equal((await w.run()).outcome, "not_due");
    }
    assert.equal(w.calls.length, canvasCalls, "repeated triggers stay cheap: the database answers");
    assert.equal(w.syncsCreated(), 1);
    assert.equal((await w.run("manual")).outcome, "success");
    assert.ok(w.calls.length > canvasCalls);
    w.advance(31 * MIN);
    assert.equal((await w.run()).outcome, "success", "due again after the cooldown");
  });

  it("a failed sync backs off 5, 10, 20, 40, 60 minutes (bounded), and success resets it", async () => {
    const w = world();
    w.canvas.fail = () => new Response("down", { status: 503 });
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await w.run();
      assert.equal(result.outcome, "temporary_error");
      assert.equal(result.errorCode, "canvas_5xx");
      waits.push((w.db.state!.next_eligible_at! - w.now()) / 1000);
      w.advance(w.db.state!.next_eligible_at! - w.now() + 1);
    }
    assert.deepEqual(waits, [300, 600, 1200, 2400, 3600, 3600]);
    assert.deepEqual(FAILURE_BACKOFF_SECONDS, [300, 600, 1200, 2400, 3600]);
    assert.equal(w.db.state?.lease_until, null);
    w.canvas.fail = undefined;
    assert.equal((await w.run()).outcome, "success");
    assert.equal(w.db.state?.consecutive_failures, 0);
  });

  it("nextEligibleSeconds is bounded for every input", () => {
    assert.equal(nextEligibleSeconds("success", 9), 1800);
    assert.equal(nextEligibleSeconds("no_linked_courses", 0), 1800);
    assert.equal(nextEligibleSeconds("auth_error", 0), AUTH_ERROR_BACKOFF_SECONDS);
    for (const failures of [-3, 0, 1, 4, 99, Number.NaN]) {
      const seconds = nextEligibleSeconds("temporary_error", failures);
      assert.ok(seconds >= 60 && seconds <= 86400, String(failures));
    }
  });

  it("no linked courses: recorded without calling Canvas", async () => {
    const w = world();
    w.db.links = [link("145580", null, "ignored")];
    const result = await w.run();
    assert.equal(result.outcome, "no_linked_courses");
    assert.deepEqual(w.calls, []);
    assert.equal(w.db.state?.last_result, "no_linked_courses");
  });
});

describe("auto-sync: concurrency (database lease)", () => {
  it("tab A claims; tab B (automatic or manual) gets already_running and never calls Canvas; A then releases", async () => {
    const w = world();
    let release!: () => void;
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    w.canvas.gate = new Promise<void>((resolve) => (release = resolve));
    w.canvas.reachedGate = reached;

    const tabA = w.run();
    await atGate; // A holds the lease and is inside Canvas
    const callsWhileA = w.calls.length;
    const tabB = await w.run();
    const manual = await w.run("manual");
    assert.equal(tabB.outcome, "already_running");
    assert.equal(manual.outcome, "already_running");
    assert.equal(w.calls.length, callsWhileA, "B made no Canvas request");
    assert.equal(w.syncsCreated(), 1);

    release();
    const a = await tabA;
    assert.equal(a.outcome, "success");
    assert.equal(w.db.state?.lease_until, null);
    assert.equal(w.db.state?.last_result, "success");
    assert.equal(w.db.tasks.size, 1);
  });

  it("a crashed run (never finished) blocks only until its lease expires", async () => {
    const w = world();
    w.state.failFinish = true;
    await w.run();
    assert.ok(w.db.state?.lease_until, "the lease is still held");
    w.state.failFinish = false;
    w.advance(MIN);
    assert.equal((await w.run("manual")).outcome, "already_running");
    w.advance(CANVAS_SYNC_LEASE_SECONDS * 1000);
    assert.equal((await w.run("manual")).outcome, "success", "the stale lease is reclaimed");
    assert.equal(w.db.tasks.size, 1);
  });

  it("an unexpected exception inside the run still records the failure and releases the lease", async () => {
    const w = world();
    const deps: LeasedSyncDeps = {
      state: w.state,
      createSync: () => {
        throw new Error(`boom ${FAKE_TOKEN}`);
      },
      now: w.now,
    };
    const result = await runLeasedCanvasSync(deps, "automatic");
    assert.equal(result.outcome, "temporary_error");
    assert.equal(result.errorCode, "unexpected");
    assert.equal(w.db.state?.lease_until, null);
    assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN));
  });

  it("a database error on claim runs nothing", async () => {
    const w = world();
    const result = await runLeasedCanvasSync({ state: { claim: async () => null, finish: async () => true }, createSync: () => assert.fail("no sync without a lease"), now: w.now }, "automatic");
    assert.deepEqual([result.outcome, result.errorCode], ["temporary_error", "database"]);
    assert.deepEqual(w.calls, []);
  });
});

describe("auto-sync: idempotency", () => {
  it("the same assignment synced ten times is one task", async () => {
    const w = world();
    for (let i = 0; i < 10; i++) {
      await w.run(i % 2 ? "manual" : "automatic");
      w.advance(31 * MIN);
    }
    assert.equal(w.db.tasks.size, 1);
  });

  it("auto then manual, and manual then auto, never duplicate", async () => {
    for (const order of [
      ["automatic", "manual"],
      ["manual", "automatic"],
    ] as const) {
      const w = world();
      const first = await w.run(order[0]);
      w.advance(31 * MIN);
      const second = await w.run(order[1]);
      assert.deepEqual([first.imported, second.imported, second.unchanged], [1, 0, 1], order.join(" → "));
      assert.equal(w.db.tasks.size, 1);
    }
  });

  it("a repeated assignment inside one response (pagination overlap) is one task", async () => {
    const w = world();
    w.canvas.assignments["145580"] = [raw("7001", "Panel"), raw("7001", "Panel")];
    await w.run();
    assert.equal(w.db.tasks.size, 1);
  });

  it("retried Canvas requests create no duplicate", async () => {
    const w = world();
    w.canvas.fail = (p, nth) => (p === "courses/145580/assignments" && nth <= 2 ? new Response("", { status: 503 }) : undefined);
    const result = await w.run();
    assert.equal(result.outcome, "success");
    assert.equal(w.calls.filter((c) => c === "courses/145580/assignments").length, 3);
    assert.equal(w.db.tasks.size, 1);
  });

  it("a partial failure writes the healthy course once, and the next run completes without duplicates", async () => {
    const w = world();
    w.canvas.assignments["145581"] = [raw("8001", "Lámina 3")];
    w.canvas.fail = (p) => (p === "courses/145581/assignments" ? new Response("", { status: 502 }) : undefined);
    const partial = await w.run();
    assert.equal(partial.outcome, "temporary_error");
    assert.equal(partial.imported, 1);
    assert.deepEqual([...w.db.tasks.keys()], ["course:145580:assignment:7001"]);

    w.canvas.fail = undefined;
    w.advance(6 * MIN);
    const next = await w.run();
    assert.equal(next.outcome, "success");
    assert.deepEqual([next.imported, next.unchanged], [1, 1]);
    assert.equal(w.db.tasks.size, 2);
  });
});

describe("auto-sync: course mappings (live Canvas list is authoritative)", () => {
  it("syncs only linked courses that Canvas still lists", async () => {
    const w = world();
    w.canvas.courses.push({ id: "145582", name: "SIN VINCULAR" }, { id: "145583", name: "IGNORADO" });
    w.canvas.assignments["145582"] = [raw("9001", "No")];
    w.canvas.assignments["145583"] = [raw("9101", "No")];
    w.db.links.push(
      link("145583", null, "ignored"),
      // Linked in the database, but Canvas no longer returns the course: never trusted.
      link("999999", P1),
      // Its project is gone (the FK cascade normally removes the row; a null project is never synced).
      link("145584", null),
    );
    w.canvas.courses.push({ id: "145584", name: "PROYECTO BORRADO" });
    w.canvas.assignments["145584"] = [raw("9201", "No")];
    w.canvas.assignments["999999"] = [raw("9301", "No")];

    const result = await w.run();
    assert.equal(result.outcome, "success");
    const fetched = w.calls.filter((c) => c.endsWith("/assignments"));
    assert.deepEqual(fetched.sort(), ["courses/145580/assignments", "courses/145581/assignments"]);
    assert.deepEqual([...w.db.tasks.keys()], ["course:145580:assignment:7001"]);
    const summary = result.sync?.ok ? result.sync.summary : null;
    assert.equal(summary?.coursesSkipped, 1, "the linked course missing from Canvas is reported, not synced");
  });

  it("a deleted project's mapping is not trusted even if a stale link row were returned", async () => {
    const w = world();
    w.db.projects.delete(P1); // the database write function refuses a course without its project
    const result = await w.run();
    assert.equal(w.db.tasks.size, 0);
    assert.equal(result.outcome, "temporary_error");
    assert.equal(result.errorCode, "database");
  });
});

describe("auto-sync: assignment preferences and conservative import", () => {
  function course() {
    const w = world();
    w.canvas.assignments["145580"] = [raw("7001", "Panel análisis territorial"), review("7002", "Visita a obra"), gradebook("7003"), attendance("7004"), raw("7005", "Memoria", { submission_types: ["on_paper"], due_at: null })];
    return w;
  }

  it("clearly actionable imports; review, gradebook and attendance do not", async () => {
    const w = course();
    const result = await w.run();
    assert.deepEqual([...w.db.tasks.keys()], ["course:145580:assignment:7001"]);
    assert.equal(result.reviewRequired, 2, "review items are counted for the Campus page, not imported");
    assert.equal(result.skipped, 2, "gradebook + attendance");
  });

  it("an included review assignment is eligible", async () => {
    const w = course();
    w.setPreference("145580", "7002", "included");
    await w.run();
    assert.ok(w.task("145580", "7002"));
    assert.ok(!w.task("145580", "7005"));
  });

  it("ignored always wins, even over a clearly actionable assignment", async () => {
    const w = course();
    w.setPreference("145580", "7001", "ignored");
    const result = await w.run();
    assert.equal(w.db.tasks.size, 0);
    assert.equal(result.ignored, 1);
  });

  it("ignoring an imported assignment removes its task, and later syncs never bring it back", async () => {
    const w = course();
    await w.run();
    assert.ok(w.task("145580", "7001"));
    w.setPreference("145580", "7001", "ignored");
    assert.equal(w.task("145580", "7001"), undefined);
    for (let i = 0; i < 3; i++) {
      w.advance(31 * MIN);
      await w.run();
    }
    assert.equal(w.task("145580", "7001"), undefined);
  });

  it("an assignment missing from one response does not delete its task", async () => {
    const w = world();
    await w.run();
    w.canvas.assignments["145580"] = [];
    w.advance(31 * MIN);
    const result = await w.run();
    assert.equal(result.outcome, "success");
    assert.ok(w.task("145580", "7001"), "absence alone is not evidence");
  });
});

describe("auto-sync: field ownership (mirrors sync_canvas_course_tasks, tested in tests/db/canvas-sync.test.ts)", () => {
  it("Canvas title and due-date changes update the task; the user's priority and completion survive", async () => {
    const w = world();
    await w.run();
    const task = w.task("145580", "7001")!;
    task.priority = "high";
    w.canvas.assignments["145580"] = [raw("7001", "Panel análisis territorial (v2)", { due_at: "2026-10-19T22:59:00Z" })];
    w.advance(31 * MIN);
    const result = await w.run();
    assert.equal(result.updated, 1);
    assert.deepEqual(
      { title: task.title, due: task.due_date, priority: task.priority },
      { title: "Panel análisis territorial (v2)", due: "2026-10-19", priority: "high" },
    );
  });

  it("a user-completed task is not reset to pending when Canvas shows no submission", async () => {
    const w = world();
    await w.run();
    w.task("145580", "7001")!.status = "done";
    w.advance(31 * MIN);
    await w.run();
    assert.equal(w.task("145580", "7001")!.status, "done");
  });

  it("a clear Canvas submission marks a pending task done; a bare 'graded' does not", async () => {
    const w = world();
    w.canvas.assignments["145580"] = [raw("7001", "Panel", { submission: { workflow_state: "graded", submitted_at: null } })];
    await w.run();
    assert.equal(w.task("145580", "7001")!.status, "pending");
    w.canvas.assignments["145580"] = [raw("7001", "Panel", { submission: { workflow_state: "submitted", submitted_at: "2026-10-08T10:00:00Z" } })];
    w.advance(31 * MIN);
    await w.run();
    assert.equal(w.task("145580", "7001")!.status, "done");
  });
});

describe("auto-sync: Canvas failures", () => {
  it("429 is retried after its Retry-After (bounded), then succeeds", async () => {
    const w = world();
    w.canvas.fail = (p, nth) => (p === "courses/145580/assignments" && nth === 1 ? new Response("", { status: 429, headers: { "Retry-After": "3" } }) : undefined);
    const result = await w.run();
    assert.equal(result.outcome, "success");
    assert.ok(w.sleeps.includes(3000), `waited for Retry-After: ${w.sleeps}`);
  });

  it("a 429 asking for longer than the bound is not waited for: the run backs off instead", async () => {
    const w = world();
    w.canvas.fail = (p) => (p === "users/self" ? new Response("", { status: 429, headers: { "Retry-After": "120" } }) : undefined);
    const result = await w.run();
    assert.deepEqual([result.outcome, result.errorCode], ["temporary_error", "canvas_429"]);
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.sleeps, []);
    assert.ok(CANVAS_MAX_RETRY_AFTER_MS <= 10_000);
  });

  it("503 is retried with exponential backoff and jitter (3 attempts at most)", async () => {
    const w = world();
    w.canvas.fail = (p) => (p === "users/self" ? new Response("", { status: 503 }) : undefined);
    const result = await w.run();
    assert.deepEqual([result.outcome, result.errorCode], ["temporary_error", "canvas_5xx"]);
    assert.equal(w.calls.length, 3);
    assert.deepEqual(w.sleeps, [500, 1000]);
  });

  for (const [status, code] of [
    [401, "canvas_401"],
    [403, "canvas_403"],
  ] as const) {
    it(`${status} is not retried, and backs off for hours (auth_error)`, async () => {
      const w = world();
      w.canvas.fail = (p) => (p === "users/self" ? new Response(`{"errors":"${FAKE_TOKEN}"}`, { status }) : undefined);
      const result = await w.run();
      assert.deepEqual([result.outcome, result.errorCode], ["auth_error", code]);
      assert.equal(w.calls.length, 1);
      assert.equal(w.db.state!.next_eligible_at! - w.now(), AUTH_ERROR_BACKOFF_SECONDS * 1000);
      assert.ok(!JSON.stringify(w.db.state).includes(FAKE_TOKEN));
    });
  }

  it("network failure and timeout are retried, then recorded with a safe code and the lease released", async () => {
    for (const [failure, code] of [
      ["network", "network"],
      ["timeout", "timeout"],
    ] as const) {
      const w = world();
      w.canvas.fail = () => failure;
      const result = await w.run();
      assert.deepEqual([result.outcome, result.errorCode], ["temporary_error", code]);
      assert.equal(w.calls.length, 3);
      assert.equal(w.db.state?.lease_until, null, "no permanent lease");
    }
  });

  it("a malformed Canvas response leaves existing tasks untouched", async () => {
    const w = world();
    await w.run();
    const before = JSON.stringify([...w.db.tasks]);
    w.canvas.fail = (p) => (p === "courses/145580/assignments" ? new Response("<html>maintenance</html>", { status: 200 }) : undefined);
    w.advance(31 * MIN);
    const result = await w.run();
    assert.equal(result.outcome, "temporary_error");
    assert.equal(result.errorCode, "unexpected");
    assert.equal(JSON.stringify([...w.db.tasks]), before);
  });

  it("maps failures to the safe code vocabulary only", () => {
    assert.equal(canvasFailureCode({ kind: "unavailable", status: 429 }), "canvas_429");
    assert.equal(canvasFailureCode({ kind: "unavailable", status: 504 }), "canvas_5xx");
    assert.equal(canvasFailureCode({ kind: "unavailable", status: null, detail: "timeout" }), "timeout");
    assert.equal(canvasFailureCode({ kind: "unavailable", status: null }), "network");
    assert.equal(canvasFailureCode({ kind: "redirected", status: 302 }), "canvas_redirect");
    assert.equal(canvasFailureCode({ kind: "not-configured", status: null }), "not_configured");
    assert.equal(canvasFailureCode(undefined), "unexpected");
    const notConfigured: CanvasSyncResult = { ok: false, error: "x", code: "not_configured" };
    assert.equal(classifySyncResult(notConfigured).outcome, "auth_error");
  });
});

describe("auto-sync: Atlantic/Canary dates", () => {
  it("due instants become Canary calendar days around midnight and both DST changes, whatever the server zone", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14: a server zone that would shift every date
    try {
      const cases: [string, string][] = [
        ["2026-10-12T22:59:00Z", "2026-10-12"], // 23:59 WEST
        ["2026-10-12T23:00:00Z", "2026-10-13"], // 00:00 WEST
        ["2026-10-24T23:30:00Z", "2026-10-25"], // 00:30 WEST, the night summer time ends
        ["2026-10-25T23:30:00Z", "2026-10-25"], // 23:30 WET, after the change
        ["2027-03-27T23:30:00Z", "2027-03-27"], // 23:30 WET, the night before summer time starts
        ["2027-03-28T23:30:00Z", "2027-03-29"], // 00:30 WEST, after the change
      ];
      for (const [instant, day] of cases) assert.equal(canvasDueDate(instant), day, instant);

      const w = world();
      w.canvas.assignments["145580"] = cases.map(([instant], i) => raw(String(7100 + i), `Entrega ${i}`, { due_at: instant }));
      await w.run();
      assert.deepEqual(
        cases.map((_, i) => w.task("145580", String(7100 + i))?.due_date),
        cases.map(([, day]) => day),
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("auto-sync: endpoint contract and security", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  const good = { [AUTO_SYNC_HEADER]: "1", origin: "https://traza.example.com", host: "traza.example.com", "sec-fetch-site": "same-origin" };

  it("accepts only same-origin POSTs carrying the TRAZA header", () => {
    assert.equal(isSameOriginRequest(headers(good)), true);
    assert.equal(isSameOriginRequest(headers({ ...good, "x-forwarded-host": "traza.example.com", host: "internal:3000" })), true);
    const without = (name: string) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== name));
    assert.equal(isSameOriginRequest(headers(without(AUTO_SYNC_HEADER))), false);
    assert.equal(isSameOriginRequest(headers(without("origin"))), false);
    assert.equal(isSameOriginRequest(headers({ ...good, origin: "https://evil.example.com" })), false);
    assert.equal(isSameOriginRequest(headers({ ...good, origin: "null" })), false);
    assert.equal(isSameOriginRequest(headers({ ...good, "sec-fetch-site": "cross-site" })), false);
    assert.equal(isSameOriginRequest(headers({ ...good, "sec-fetch-site": "same-site" })), false);
  });

  it("answers only an outcome and whether something changed: no counts, ids, names or codes", async () => {
    const w = world();
    const result = await w.run();
    assert.deepEqual(autoSyncResponse(result), { outcome: "success", changed: true });
    w.advance(MIN);
    assert.deepEqual(autoSyncResponse(await w.run()), { outcome: "not_due", changed: false });
  });

  it("the development log line carries enums and counts only", async () => {
    const w = world();
    const line = syncLogLine(await w.run());
    assert.match(line, /^TRAZA Canvas auto-sync: outcome=success trigger=automatic courses=2 seen=1 imported=1 updated=0 unchanged=0 ignored=0 review=0 duration=\d+ms$/);
    for (const secret of [FAKE_TOKEN, "Panel", "TALLER", P1, BASE]) assert.ok(!line.includes(secret), secret);
  });

  const ROOT = process.cwd();
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("the endpoint is POST only, verifies the session and the origin, and never reads the request body or query", () => {
    const route = read("app/api/integrations/canvas/auto-sync/route.ts");
    assert.match(route, /export async function POST\(/);
    assert.doesNotMatch(route, /export (async )?function (GET|PUT|PATCH|DELETE)\b/);
    assert.match(route, /isSameOriginRequest\(request\.headers\)/);
    assert.match(route, /getSessionUser\(\)/);
    assert.match(route, /if \(!user\) return json\(\{ error: "unauthorized" \}, 401\)/);
    assert.doesNotMatch(route, /request\.(json|text|formData|arrayBuffer|body)|searchParams|user_id|courseId|projectId|assignmentId/);
    // Signed-out API writes get a 401 from the proxy too, instead of a redirect.
    assert.match(read("lib/supabase/proxy.ts"), /pathname\.startsWith\("\/api\/"\) && request\.method !== "GET"/);
  });

  it("the state functions take no user id: they act on auth.uid() only", () => {
    const store = read("lib/canvas/sync-state-store.ts");
    assert.doesNotMatch(store, /p_user/);
    const migration = read("supabase/migrations/20261007083209_canvas_sync_state.sql");
    assert.doesNotMatch(migration, /p_user_id/);
    assert.match(migration, /enable row level security/);
  });

  function files(dir: string, accept: (file: string) => boolean): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full, accept) : accept(full) ? [full] : [];
    });
  }

  it("no client code can reach the Canvas token, and no service role is used anywhere", () => {
    const sources = ["app", "components", "lib"].flatMap((dir) => files(path.join(ROOT, dir), (f) => /\.tsx?$/.test(f)));
    const client = sources.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    assert.ok(client.some((f) => f.endsWith("CanvasAutoSyncTrigger.tsx")));
    for (const file of client) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /@\/lib\/canvas\/(queries|env|client|read|sync-deps|sync-state-store|sync-store|links)["']/, path.relative(ROOT, file));
      assert.doesNotMatch(text, /CANVAS_ACCESS_TOKEN|CANVAS_BASE_URL/, path.relative(ROOT, file));
    }
    for (const file of ["lib/canvas/sync-deps.ts", "lib/canvas/sync-state-store.ts", "lib/canvas/queries.ts"]) assert.match(read(file), /^import "server-only";/, file);
    const everything = sources.map((f) => readFileSync(f, "utf8")).join("\n");
    assert.doesNotMatch(everything, /SERVICE_ROLE|service_role_key|serviceRole/i);
  });

  it("the built browser bundle (if present) contains no Canvas token variable or sync internals", () => {
    const bundle = files(path.join(ROOT, ".next", "static"), (f) => f.endsWith(".js"));
    if (bundle.length === 0) return; // not built yet
    const text = bundle.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const needle of ["CANVAS_ACCESS_TOKEN", "CANVAS_BASE_URL", "claim_canvas_sync", "finish_canvas_sync", "TRAZA Canvas auto-sync"]) assert.ok(!text.includes(needle), needle);
  });

  it("the trigger is in the private layout only (never on /login or the root layout)", () => {
    assert.match(read("app/(app)/layout.tsx"), /<CanvasAutoSyncTrigger \/>/);
    assert.match(read("app/(app)/layout.tsx"), /await requireUser\(\)/);
    for (const file of [...files(path.join(ROOT, "app", "login"), () => true), path.join(ROOT, "app", "layout.tsx")]) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /CanvasAutoSyncTrigger/, path.relative(ROOT, file));
    }
    const trigger = read("components/canvas/CanvasAutoSyncTrigger.tsx");
    assert.match(trigger, /method: "POST"/);
    const request = trigger.match(/fetch\(AUTO_SYNC_PATH, \{([^}]*\})[^}]*\}\)/)?.[1] ?? "";
    assert.match(request, /method: "POST"/);
    assert.doesNotMatch(request, /body/, "the trigger sends no body");
    assert.match(trigger, /AUTO_SYNC_INTERVAL_MS/);
  });
});

describe("auto-sync: Campus status", () => {
  const row = (fields: Partial<Parameters<typeof syncStatusView>[0] & object> = {}) => ({
    lease_until: null,
    last_success_at: null,
    last_attempt_at: null,
    last_result: null,
    last_review_count: 0,
    ...fields,
  });
  const now = START;
  const ago = (minutes: number) => new Date(now - minutes * MIN).toISOString();

  it("shows a state, the last success and the review count, never details", () => {
    assert.deepEqual(syncStatusView(null, now), { status: "SIN SINCRONIZAR", lastSync: "Nunca", reviewCount: 0 });
    assert.deepEqual(syncStatusView(row({ last_result: "success", last_success_at: ago(12), last_review_count: 3 }), now), { status: "ACTUALIZADO", lastSync: "Hace 12 min", reviewCount: 3 });
    assert.equal(syncStatusView(row({ lease_until: new Date(now + MIN).toISOString(), last_result: "success" }), now).status, "EN CURSO");
    assert.equal(syncStatusView(row({ lease_until: ago(1), last_result: "success" }), now).status, "ACTUALIZADO", "an expired lease is not running");
    assert.equal(syncStatusView(row({ last_result: "auth_error", last_success_at: ago(300) }), now).status, "REVISAR CONEXIÓN");
    assert.equal(syncStatusView(row({ last_result: "temporary_error" }), now).status, "ERROR TEMPORAL");
    assert.equal(syncStatusView(row({ last_result: "no_linked_courses", last_success_at: ago(0) }), now).lastSync, "Hace un momento");
  });

  it("formats relative times in Spanish", () => {
    assert.equal(relativeTime(now - 30_000, now), "Hace un momento");
    assert.equal(relativeTime(now - 59 * MIN, now), "Hace 59 min");
    assert.equal(relativeTime(now - 3 * 60 * MIN, now), "Hace 3 h");
    assert.equal(relativeTime(now - 26 * 60 * MIN, now), "Hace 1 día");
    assert.equal(relativeTime(now - 72 * 60 * MIN, now), "Hace 3 días");
  });
});
