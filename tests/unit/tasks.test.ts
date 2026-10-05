import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, currentISODate } from "@/lib/calendar/dates";
import { formatDueLabel } from "@/lib/tasks/format";
import { isTaskId, parseDueDate, parsePriority, parseProjectId, parseTaskDetails, parseTitle } from "@/lib/tasks/validation";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const PROJECT = "3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b";

describe("task validation", () => {
  it("trims titles and rejects blank or overlong ones (code points, like Postgres)", () => {
    assert.deepEqual(parseTitle("  Comprar cartón pluma  "), { ok: true, value: "Comprar cartón pluma" });
    assert.equal(parseTitle("   ").ok, false);
    assert.equal(parseTitle("🙂".repeat(500)).ok, true);
    assert.equal(parseTitle("a".repeat(501)).ok, false);
  });

  it("accepts only real calendar dates in range", () => {
    assert.deepEqual(parseDueDate(""), { ok: true, value: null });
    assert.deepEqual(parseDueDate("2026-10-06"), { ok: true, value: "2026-10-06" });
    for (const bad of ["2026-02-30", "2026-10-06T00:00:00Z", "mañana", "9999-01-01"]) {
      assert.equal(parseDueDate(bad).ok, false, bad);
    }
  });

  it("accepts only known priorities, defaulting to normal", () => {
    assert.deepEqual(parsePriority(""), { ok: true, value: "normal" });
    assert.deepEqual(parsePriority("high"), { ok: true, value: "high" });
    assert.equal(parsePriority("urgent").ok, false);
  });

  it("accepts an empty or UUID project id, rejecting mock slugs", () => {
    assert.deepEqual(parseProjectId(""), { ok: true, value: null });
    assert.deepEqual(parseProjectId(PROJECT.toUpperCase()), { ok: true, value: PROJECT });
    assert.equal(parseProjectId("taller-proyectos").ok, false);
    assert.equal(parseProjectId("1; drop table tasks").ok, false);
  });

  it("reads only editable fields and ignores user_id or source", () => {
    const parsed = parseTaskDetails(
      form({ title: "x", due_date: "", priority: "low", project_id: PROJECT, user_id: PROJECT, source: "canvas" }),
    );
    assert.deepEqual(parsed, { ok: true, value: { title: "x", due_date: null, priority: "low", project_id: PROJECT } });
  });

  it("clears the project only when the field is present and empty", () => {
    const cleared = parseTaskDetails(form({ title: "x", project_id: "" }));
    assert.ok(cleared.ok && cleared.value.project_id === null);
    // No field (e.g. projects failed to load): leave the stored project untouched.
    const untouched = parseTaskDetails(form({ title: "x" }));
    assert.ok(untouched.ok && !("project_id" in untouched.value));
  });

  it("rejects an invalid project id", () => {
    assert.deepEqual(parseTaskDetails(form({ title: "x", project_id: "astronomia" })), {
      ok: false,
      error: "El proyecto no es válido.",
    });
  });

  it("validates task ids as UUIDs", () => {
    assert.equal(isTaskId(PROJECT), true);
    assert.equal(isTaskId("1; drop table tasks"), false);
  });
});

describe("dates", () => {
  it("adds days across month end, DST change and year end", () => {
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-10-24", 2), "2026-10-26");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });

  it("formats the current date as YYYY-MM-DD in any zone", () => {
    assert.match(currentISODate(), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(currentISODate("UTC"), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("due labels", () => {
  const today = "2026-10-05";
  it("labels today, tomorrow, overdue, later and another year", () => {
    assert.deepEqual(formatDueLabel("2026-10-05", today), { text: "Hoy", urgent: true });
    assert.deepEqual(formatDueLabel("2026-10-06", today), { text: "Mañana", urgent: false });
    assert.deepEqual(formatDueLabel("2026-10-04", today), { text: "Vencida · 4 OCT", urgent: true });
    assert.deepEqual(formatDueLabel("2026-10-12", today), { text: "12 OCT", urgent: false });
    assert.deepEqual(formatDueLabel("2027-01-15", today), { text: "15 ENE 2027", urgent: false });
    assert.equal(formatDueLabel(null, today), null);
  });
});
