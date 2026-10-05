import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInboxFeed, entryDateLabel, filterEntries, inboxFilters, resolveInboxFilter } from "@/lib/inbox/feed";
import type { InboxCapture } from "@/lib/inbox/types";
import { parseCapture, parseCaptureDetails, splitCapture, taskTitleFromCapture, isInboxItemId } from "@/lib/inbox/validation";
import type { InboxTask } from "@/lib/tasks/types";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe("capture parsing", () => {
  it("splits idea/note text: first line title, the rest content", () => {
    assert.deepEqual(splitCapture("  Vivienda semienterrada \n\nExcavar en la ladera.\nInercia térmica.  "), {
      ok: true,
      value: { title: "Vivienda semienterrada", content: "Excavar en la ladera.\nInercia térmica." },
    });
    assert.deepEqual(splitCapture("Solo una línea"), { ok: true, value: { title: "Solo una línea", content: null } });
    assert.deepEqual(splitCapture("Windows\r\nlíneas"), { ok: true, value: { title: "Windows", content: "líneas" } });
  });

  it("keeps a first line too long for a title as content, and rejects empty or overlong text", () => {
    const long = "a".repeat(201);
    assert.deepEqual(splitCapture(long), { ok: true, value: { title: null, content: long } });
    assert.equal(splitCapture(" \n\t ").ok, false);
    assert.equal(splitCapture(`Título\n${"a".repeat(10001)}`).ok, false);
  });

  it("turns task text into one line and applies the task title rules", () => {
    assert.deepEqual(taskTitleFromCapture("Imprimir\n  A1 "), { ok: true, value: "Imprimir A1" });
    assert.equal(taskTitleFromCapture("a".repeat(501)).ok, false);
  });

  it("parses a task capture with Home's defaults, for public.tasks", () => {
    assert.deepEqual(parseCapture(form({ kind: "task", text: "Comprar cartón pluma", project_id: id(1) })), {
      ok: true,
      value: { kind: "task", task: { title: "Comprar cartón pluma", due_date: null, priority: "normal", project_id: id(1) } },
    });
  });

  it("parses idea and note captures for public.inbox_items, ignoring forbidden fields", () => {
    const parsed = parseCapture(
      form({ kind: "idea", text: "Idea\nDetalle", source: "ai", external_id: "x", user_id: id(9), status: "done" }),
    );
    assert.deepEqual(parsed, { ok: true, value: { kind: "idea", item: { kind: "idea", title: "Idea", content: "Detalle", project_id: null } } });
    const note = parseCapture(form({ kind: "note", text: "Nota" }));
    assert.ok(note.ok && note.value.kind === "note");
  });

  it("rejects empty captures, invalid kinds and invalid project ids", () => {
    assert.equal(parseCapture(form({ kind: "task", text: "  " })).ok, false);
    assert.equal(parseCapture(form({ kind: "idea", text: "" })).ok, false);
    assert.equal(parseCapture(form({ kind: "event", text: "x" })).ok, false);
    assert.equal(parseCapture(form({ text: "x" })).ok, false);
    assert.equal(parseCapture(form({ kind: "note", text: "x", project_id: "astronomia" })).ok, false);
  });

  it("edits kind, title, content and project; at least one of title or content", () => {
    assert.deepEqual(parseCaptureDetails(form({ kind: "note", title: " ", content: " Texto ", project_id: "" })), {
      ok: true,
      value: { kind: "note", title: null, content: "Texto", project_id: null },
    });
    assert.equal(parseCaptureDetails(form({ kind: "note", title: "", content: "" })).ok, false);
    assert.equal(parseCaptureDetails(form({ kind: "task", title: "x" })).ok, false);
    const untouched = parseCaptureDetails(form({ kind: "idea", title: "x" }));
    assert.ok(untouched.ok && !("project_id" in untouched.value));
  });

  it("validates record ids as UUIDs", () => {
    assert.equal(isInboxItemId(id(1)), true);
    assert.equal(isInboxItemId("in-01"), false);
  });
});

function task(n: number, createdAt: string, extra: Partial<InboxTask> = {}): InboxTask {
  return { id: id(100 + n), title: `Tarea ${n}`, status: "pending", priority: "normal", due_date: null, completed_at: null, project_id: null, created_at: createdAt, ...extra };
}

function capture(n: number, kind: string, createdAt: string, extra: Partial<InboxCapture> = {}): InboxCapture {
  return { id: id(200 + n), kind, title: `Captura ${n}`, content: null, project_id: null, source: "manual", created_at: createdAt, ...extra };
}

const projects = [{ id: id(1), name: "Taller de Proyectos" }];

describe("unified Inbox feed", () => {
  const tasks = [task(1, "2026-10-05T09:40:00+00:00", { project_id: id(1) }), task(2, "2026-10-04T22:10:00+00:00")];
  const captures = [
    capture(1, "idea", "2026-10-05T08:30:00+00:00", { project_id: id(1) }),
    capture(2, "note", "2026-10-05T07:55:00+00:00"),
    capture(3, "note", "2026-10-05T09:40:00+00:00"),
  ];
  const feed = buildInboxFeed(tasks, captures, projects);

  it("merges both sources newest first, with a deterministic tie-break", () => {
    assert.deepEqual(
      feed.map((entry) => `${entry.kind}:${entry.id.slice(-3)}`),
      ["task:101", "note:203", "idea:201", "note:202", "task:102"],
    );
  });

  it("keeps the real task row (the same record Home shows), its id and table", () => {
    const entry = feed[0];
    assert.equal(entry.kind, "task");
    assert.ok(entry.kind === "task" && entry.task === tasks[0]);
    assert.equal(entry.id, tasks[0].id);
    assert.equal(feed.filter((e) => e.id === tasks[0].id).length, 1);
  });

  it("resolves project names and ignores unknown kinds", () => {
    assert.equal(feed[0].projectName, "Taller de Proyectos");
    assert.equal(buildInboxFeed([], [capture(9, "task", "2026-10-05T10:00:00+00:00")], projects).length, 0);
  });

  it("filters by kind and counts each filter", () => {
    const counts = inboxFilters.map((filter) => [filter.label, filterEntries(feed, filter).length]);
    assert.deepEqual(counts, [["Todo", 5], ["Tareas", 2], ["Ideas", 1], ["Notas", 2]]);
    assert.equal(resolveInboxFilter("ideas").kind, "idea");
    assert.equal(resolveInboxFilter("otra").kind, null);
  });
});

describe("Inbox date labels (Atlantic/Canary)", () => {
  const today = "2026-10-05";

  it("uses the local capture day, not UTC", () => {
    // 23:30 UTC on 4 Oct is 00:30 on 5 Oct in the Canaries (WEST, UTC+1).
    const [entry] = buildInboxFeed([], [capture(1, "note", "2026-10-04T23:30:00+00:00")], []);
    assert.deepEqual(entryDateLabel(entry, today), { text: "Hoy", emphasis: false });
    const [yesterday] = buildInboxFeed([], [capture(2, "note", "2026-10-04T12:00:00+00:00")], []);
    assert.equal(entryDateLabel(yesterday, today).text, "Ayer");
    const [older] = buildInboxFeed([], [capture(3, "idea", "2026-09-28T12:00:00+00:00")], []);
    assert.equal(entryDateLabel(older, today).text, "28 SEPT");
    const [lastYear] = buildInboxFeed([], [capture(4, "idea", "2025-12-30T12:00:00+00:00")], []);
    assert.equal(entryDateLabel(lastYear, today).text, "30 DIC 2025");
  });

  it("shows a task's due date instead, emphasised when due or overdue and still pending", () => {
    const [due] = buildInboxFeed([task(1, "2026-10-01T10:00:00+00:00", { due_date: "2026-10-04" })], [], []);
    assert.deepEqual(entryDateLabel(due, today), { text: "Vencida · 4 OCT", emphasis: true });
    const [done] = buildInboxFeed([task(2, "2026-10-01T10:00:00+00:00", { due_date: "2026-10-05", status: "done" })], [], []);
    assert.deepEqual(entryDateLabel(done, today), { text: "Hoy", emphasis: false });
  });
});
