// Canvas assignment sync: parsing, dates, relevance and identity (the engine is in
// canvas-sync-engine.test.ts). No network, no database, no real credentials (the token is a fake fixture).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSIGNMENT_PARAMS,
  RECENT_PAST_DAYS,
  assignmentExternalId,
  assignmentRelevance,
  assignmentTitle,
  canvasDueDate,
  fetchCourseAssignments,
  isCanvasInstant,
  isSubmitted,
  parseAssignment,
  parseAssignments,
  toTaskWrite,
  type CanvasTaskWrite,
} from "@/lib/canvas/assignments";
import { createCanvasClient, type FetchLike } from "@/lib/canvas/client";
import { readCourseAssignments } from "@/lib/canvas/read";
import type { CanvasAssignment } from "@/lib/canvas/types";
import { nextMilestones, withTaskCounts } from "@/lib/projects/projects";
import { parseTaskEdit } from "@/lib/tasks/validation";

const FAKE_TOKEN = "1234~FAKE-test-token-not-real-0000";
const TODAY = "2026-10-06";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function raw(overrides: Record<string, unknown> = {}) {
  return {
    id: "7001",
    course_id: "145580",
    name: "Panel análisis territorial",
    description: "<p>Entrega <b>A1</b> con <script>x</script></p>",
    due_at: "2026-10-12T22:59:00Z",
    unlock_at: null,
    lock_at: "2026-10-13T22:59:00Z",
    published: true,
    created_at: "2026-09-20T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
    html_url: "https://campus.example.edu/courses/145580/assignments/7001",
    submission: { workflow_state: "unsubmitted", submitted_at: null, excused: false },
    submission_types: ["online_upload"],
    grading_type: "points",
    points_possible: 10,
    omit_from_final_grade: false,
    ...overrides,
  };
}

function assignment(overrides: Partial<CanvasAssignment> = {}): CanvasAssignment {
  return {
    id: "7001",
    courseId: "145580",
    name: "Panel análisis territorial",
    dueAt: "2026-10-12T22:59:00Z",
    unlockAt: null,
    lockAt: null,
    published: true,
    workflowState: null,
    createdAt: "2026-09-20T10:00:00Z",
    updatedAt: null,
    submission: null,
    submissionTypes: ["online_upload"],
    gradingType: "points",
    pointsPossible: 10,
    omitFromFinalGrade: false,
    ...overrides,
  };
}

describe("Canvas assignment parsing", () => {
  it("projects only the fields TRAZA uses (no HTML, no URLs)", () => {
    assert.deepEqual(parseAssignment(raw(), "145580"), {
      id: "7001",
      courseId: "145580",
      name: "Panel análisis territorial",
      dueAt: "2026-10-12T22:59:00Z",
      unlockAt: null,
      lockAt: "2026-10-13T22:59:00Z",
      published: true,
      workflowState: null,
      createdAt: "2026-09-20T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      submission: { workflowState: "unsubmitted", submittedAt: null, excused: false },
      submissionTypes: ["online_upload"],
      gradingType: "points",
      pointsPossible: 10,
      omitFromFinalGrade: false,
    });
  });

  it("tolerates missing optional fields and numeric ids", () => {
    const parsed = parseAssignment({ id: 7001, name: " Maqueta " }, "145580");
    assert.deepEqual(parsed, {
      id: "7001",
      courseId: "145580",
      name: "Maqueta",
      dueAt: null,
      unlockAt: null,
      lockAt: null,
      published: null,
      workflowState: null,
      createdAt: null,
      updatedAt: null,
      submission: null,
      submissionTypes: null,
      gradingType: null,
      pointsPossible: null,
      omitFromFinalGrade: null,
    });
    // An unreadable optional timestamp is dropped, not fatal.
    assert.equal(parseAssignment(raw({ lock_at: "mañana" }), "145580")?.lockAt, null);
  });

  it("rejects malformed rows: no id, no name, a bad due date, another course", () => {
    for (const bad of [
      null,
      "x",
      [],
      raw({ id: undefined }),
      raw({ id: "7a" }),
      raw({ id: -1 }),
      raw({ id: 1.5 }),
      raw({ name: "  " }),
      raw({ name: 42 }),
      raw({ due_at: "12/10/2026" }),
      raw({ due_at: "2026-10-12T22:59:00" }), // no offset: the zone would be a guess
      raw({ due_at: "2026-13-45T25:00:00Z" }),
      raw({ due_at: 1760309940 }),
      raw({ course_id: "999" }),
    ]) {
      assert.equal(parseAssignment(bad, "145580"), null, JSON.stringify(bad));
    }
  });

  it("counts malformed rows instead of failing the list", () => {
    const { assignments, malformed } = parseAssignments([raw(), raw({ id: null }), raw({ id: "7002" }), "junk"], "145580");
    assert.deepEqual(assignments.map((a) => a.id), ["7001", "7002"]);
    assert.equal(malformed, 2);
  });

  it("accepts only instants with an explicit offset", () => {
    for (const ok of ["2026-10-12T22:59:00Z", "2026-10-12T22:59:00.123Z", "2026-10-12T23:59:00+01:00", "2026-10-12T22:59Z"]) assert.ok(isCanvasInstant(ok), ok);
    for (const bad of ["2026-10-12", "2026-10-12 22:59:00Z", "2026-10-12T22:59:00", "nope"]) assert.ok(!isCanvasInstant(bad), bad);
  });
});

describe("Canvas due dates in Atlantic/Canary", () => {
  it("keeps 22:59 UTC in summer on the same day (23:59 WEST)", () => {
    assert.equal(canvasDueDate("2026-10-12T22:59:00Z"), "2026-10-12");
  });

  it("moves 23:00 UTC in summer to the next day (00:00 WEST)", () => {
    assert.equal(canvasDueDate("2026-10-12T23:00:00Z"), "2026-10-13");
  });

  it("keeps 23:59 UTC in winter on the same day (WET = UTC)", () => {
    assert.equal(canvasDueDate("2026-11-12T23:59:00Z"), "2026-11-12");
  });

  it("is right on both sides of the October 2026 change (25 Oct, 01:00 UTC)", () => {
    assert.equal(canvasDueDate("2026-10-24T23:30:00Z"), "2026-10-25"); // 00:30 WEST
    assert.equal(canvasDueDate("2026-10-25T00:30:00Z"), "2026-10-25"); // 01:30 WEST
    assert.equal(canvasDueDate("2026-10-25T23:30:00Z"), "2026-10-25"); // 23:30 WET
  });

  it("is right on both sides of the March 2027 change (28 Mar, 01:00 UTC)", () => {
    assert.equal(canvasDueDate("2027-03-27T23:30:00Z"), "2027-03-27"); // 23:30 WET
    assert.equal(canvasDueDate("2027-03-28T23:30:00Z"), "2027-03-29"); // 00:30 WEST
  });

  it("honours explicit offsets", () => {
    assert.equal(canvasDueDate("2026-10-12T23:59:00+01:00"), "2026-10-12");
    assert.equal(canvasDueDate("2026-10-13T00:30:00+02:00"), "2026-10-12");
  });

  it("imports undated assignments without a deadline", () => {
    assert.equal(toTaskWrite(assignment({ dueAt: null }))?.due_date, null);
  });
});

describe("Canvas assignment identity and task writes", () => {
  it("builds a stable compound external id", () => {
    assert.equal(assignmentExternalId("145580", "7001"), "course:145580:assignment:7001");
    assert.notEqual(assignmentExternalId("145580", "7001"), assignmentExternalId("145581", "7001"));
    assert.notEqual(assignmentExternalId("1", "45580"), assignmentExternalId("14", "5580"));
  });

  it("writes exactly the Canvas-managed fields, from the name only", () => {
    assert.deepEqual(toTaskWrite(assignment()), {
      assignment_id: "7001",
      title: "Panel análisis territorial",
      due_date: "2026-10-12",
      submitted: false,
    } satisfies CanvasTaskWrite);
  });

  it("collapses whitespace and clips titles to the task limit", () => {
    assert.equal(assignmentTitle("  Panel\n\n análisis \t territorial "), "Panel análisis territorial");
    assert.equal([...assignmentTitle("á".repeat(600))].length, 500);
  });

  it("treats only clear Canvas submissions as done", () => {
    const sub = (workflowState: string | null, submittedAt: string | null, excused = false) => ({ workflowState, submittedAt, excused });
    assert.equal(isSubmitted(sub("submitted", "2026-10-10T10:00:00Z")), true);
    assert.equal(isSubmitted(sub("pending_review", "2026-10-10T10:00:00Z")), true);
    assert.equal(isSubmitted(sub("graded", "2026-10-10T10:00:00Z")), true);
    assert.equal(isSubmitted(sub("graded", null)), false); // graded without a submission (e.g. missing work)
    assert.equal(isSubmitted(sub("unsubmitted", null)), false);
    assert.equal(isSubmitted(sub(null, "2026-10-10T10:00:00Z")), false);
    assert.equal(isSubmitted(sub("unsubmitted", "2026-10-10T10:00:00Z")), false);
    assert.equal(isSubmitted(sub("excused_state", null, true)), false);
    assert.equal(isSubmitted(null), false);
  });
});

describe("Canvas assignment relevance", () => {
  const relevance = (overrides: Partial<CanvasAssignment>) => assignmentRelevance(assignment(overrides), TODAY);

  it("never imports unpublished assignments", () => {
    assert.deepEqual(relevance({ published: false }), { relevant: false, reason: "unpublished" });
    assert.deepEqual(relevance({ workflowState: "unpublished" }), { relevant: false, reason: "unpublished" });
    assert.deepEqual(relevance({ workflowState: "deleted", published: null }), { relevant: false, reason: "unpublished" });
    // Not reported (students normally only see published ones): accepted.
    assert.deepEqual(relevance({ published: null }), { relevant: true });
  });

  it("keeps future and recent past deadlines, drops older history", () => {
    assert.deepEqual(relevance({ dueAt: "2027-06-01T10:00:00Z" }), { relevant: true });
    assert.deepEqual(relevance({ dueAt: "2026-09-06T12:00:00Z" }), { relevant: true }); // exactly 30 days ago
    assert.deepEqual(relevance({ dueAt: "2026-09-05T12:00:00Z" }), { relevant: false, reason: "past" });
    assert.deepEqual(relevance({ dueAt: "2023-05-01T12:00:00Z", createdAt: "2026-10-01T00:00:00Z" }), { relevant: false, reason: "past" });
    assert.equal(RECENT_PAST_DAYS, 30);
  });

  it("keeps undated assignments only when recent and still open", () => {
    assert.deepEqual(relevance({ dueAt: null, createdAt: "2026-06-01T00:00:00Z" }), { relevant: true });
    assert.deepEqual(relevance({ dueAt: null, createdAt: "2025-01-01T00:00:00Z" }), { relevant: false, reason: "stale-undated" });
    assert.deepEqual(relevance({ dueAt: null, createdAt: null }), { relevant: false, reason: "stale-undated" });
    assert.deepEqual(relevance({ dueAt: null, lockAt: "2026-10-01T00:00:00Z" }), { relevant: false, reason: "stale-undated" });
    assert.deepEqual(relevance({ dueAt: null, lockAt: "2026-12-01T00:00:00Z" }), { relevant: true });
  });

});

describe("Canvas assignment fetching", () => {
  const config = { baseUrl: "https://campus.example.edu", token: FAKE_TOKEN };

  function pagedFetch(total: number, pageSize = 100) {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const items = Array.from({ length: Math.min(pageSize, total - (page - 1) * pageSize) }, (_, i) => raw({ id: String((page - 1) * pageSize + i + 1) }));
      const headers = new Headers();
      if (page * pageSize < total) {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        headers.set("Link", `<${next}>; rel="next"`);
      }
      return new Response(JSON.stringify(items), { status: 200, headers });
    };
    return { fetch, calls };
  }

  it("follows every page (more than 100 assignments) with the submission include", async () => {
    const { fetch, calls } = pagedFetch(250);
    const result = await fetchCourseAssignments(createCanvasClient(config, { fetch }), "145580");
    assert.equal(result.assignments.length, 250);
    assert.equal(new Set(result.assignments.map((a) => a.id)).size, 250);
    assert.deepEqual([result.malformed, result.truncated], [0, false]);
    assert.equal(calls.length, 3);
    const first = new URL(calls[0]);
    assert.equal(first.pathname, "/api/v1/courses/145580/assignments");
    assert.deepEqual(first.searchParams.getAll("include[]"), ["submission"]);
    assert.equal(first.searchParams.get("per_page"), "100");
    assert.equal(first.searchParams.get("order_by"), ASSIGNMENT_PARAMS.order_by);
    assert.ok(calls.every((url) => !url.includes(FAKE_TOKEN)));
  });

  it("reports truncation at the page limit", async () => {
    const { fetch } = pagedFetch(500);
    const result = await fetchCourseAssignments(createCanvasClient(config, { fetch, maxPages: 2 }), "145580");
    assert.deepEqual([result.assignments.length, result.truncated], [200, true]);
  });

  it("never builds a path from a non-numeric course id", async () => {
    const { fetch, calls } = pagedFetch(1);
    for (const bad of ["../users/self", "145580/assignments?x=", "", "1 2"]) {
      await assert.rejects(fetchCourseAssignments(createCanvasClient(config, { fetch }), bad));
    }
    assert.equal(calls.length, 0);
  });

  it("returns { ok: false } with only a safe category on Canvas errors, never the body or the token", async () => {
    for (const [status, kind] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "invalid-response"],
      [500, "unavailable"],
    ] as const) {
      const fetch: FetchLike = async () => new Response(`secret body ${FAKE_TOKEN}`, { status });
      const result = await readCourseAssignments({ ok: true, config }, "145580", { fetch, retryDelayMs: 0 });
      assert.deepEqual(result, { ok: false, failure: { kind, status, detail: null } });
      assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN));
    }
    const offOrigin: FetchLike = async () =>
      new Response("[]", { status: 200, headers: { Link: '<https://evil.example.com/api/v1/x?page=2>; rel="next"' } });
    assert.deepEqual(await readCourseAssignments({ ok: true, config }, "145580", { fetch: offOrigin }), { ok: false, failure: { kind: "invalid-response", status: null, detail: null } });
    assert.deepEqual(await readCourseAssignments({ ok: false, problem: "missing" }, "145580"), { ok: false, failure: { kind: "not-configured", status: null } });
  });
});

// ---------------------------------------------------------------------------
// TRAZA side: edit rules and project milestones
// ---------------------------------------------------------------------------

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe("editing imported tasks", () => {
  const edit = form({ title: "Otro título", due_date: "2026-12-01", priority: "high", project_id: uuid(2) });

  it("a Canvas task only accepts priority; Canvas-managed fields are ignored", () => {
    assert.deepEqual(parseTaskEdit("canvas", edit), { ok: true, value: { priority: "high" } });
    assert.equal(parseTaskEdit("canvas", form({ priority: "urgent" })).ok, false);
    // Priority alone is enough: no title is required for a Canvas task.
    assert.deepEqual(parseTaskEdit("canvas", form({})), { ok: true, value: { priority: "normal" } });
  });

  it("manual tasks stay fully editable", () => {
    assert.deepEqual(parseTaskEdit("manual", edit), {
      ok: true,
      value: { title: "Otro título", due_date: "2026-12-01", priority: "high", project_id: uuid(2) },
    });
  });
});

describe("project next milestone", () => {
  const task = (id: number, projectId: string | null, due: string | null, status = "pending", title = `Tarea ${id}`) => ({ id: uuid(id), project_id: projectId, due_date: due, status, title });
  const event = (id: number, projectId: string | null, date: string, title = `Evento ${id}`) => ({ id: uuid(100 + id), project_id: projectId, event_date: date, title });

  it("takes the earliest pending task due today or later, or event, whichever is first", () => {
    const milestones = nextMilestones(
      [task(1, uuid(1), "2026-10-12", "pending", "Panel análisis territorial"), task(2, uuid(1), "2026-10-20"), task(3, uuid(2), "2026-10-30")],
      [event(1, uuid(2), "2026-10-09", "Corrección"), event(2, uuid(1), "2026-10-15")],
      TODAY,
    );
    assert.deepEqual(milestones.get(uuid(1)), { kind: "task", title: "Panel análisis territorial", date: "2026-10-12" });
    assert.deepEqual(milestones.get(uuid(2)), { kind: "event", title: "Corrección", date: "2026-10-09" });
  });

  it("ignores done, overdue and undated tasks, past events and unassigned items", () => {
    const milestones = nextMilestones(
      [task(1, uuid(1), "2026-10-07", "done"), task(2, uuid(1), "2026-10-01"), task(3, uuid(1), null), task(4, null, "2026-10-07")],
      [event(1, uuid(1), "2026-10-05"), event(2, null, "2026-10-07")],
      TODAY,
    );
    assert.equal(milestones.size, 0);
  });

  it("on the same day prefers the task deadline, then title", () => {
    const milestones = nextMilestones([task(1, uuid(1), TODAY, "pending", "Zócalo")], [event(1, uuid(1), TODAY, "Avance")], TODAY);
    assert.equal(milestones.get(uuid(1))?.kind, "task");
  });

  it("is attached by withTaskCounts, and counts include imported tasks like any other", () => {
    const summary = { name: "Taller", area: null, description: null, status: "active", progress: 0, created_at: "2026-10-01T00:00:00Z" };
    const [project] = withTaskCounts(
      [{ id: uuid(1), ...summary }],
      [{ project_id: uuid(1), status: "pending" }],
      new Set(),
      nextMilestones([task(1, uuid(1), "2026-10-12")], [], TODAY),
    );
    assert.equal(project.pendingTaskCount, 1);
    assert.equal(project.nextMilestone?.date, "2026-10-12");
  });
});
