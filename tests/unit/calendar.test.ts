import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMonthWeeks } from "@/lib/calendar/dates";
import { buildCalendarItems, eventToItem, groupItemsByDate, itemsOn, taskToDeadlineItem, upcomingDeadlines } from "@/lib/calendar/items";
import type { CalendarEventRecord } from "@/lib/calendar/types";
import {
  isEventId,
  parseEventDate,
  parseEventDetails,
  parseEventTimes,
  parseEventTitle,
  parseTime,
} from "@/lib/calendar/validation";
import { addMonths, adjacentMonthHrefs, calendarHref, lastDayOfMonth, resolveCalendarView } from "@/lib/calendar/view";
import type { DeadlineTask } from "@/lib/tasks/types";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe("event validation", () => {
  it("trims titles and enforces 1–200 characters", () => {
    assert.deepEqual(parseEventTitle("  Tutoría "), { ok: true, value: "Tutoría" });
    assert.equal(parseEventTitle("  ").ok, false);
    assert.equal(parseEventTitle("é".repeat(200)).ok, true);
    assert.equal(parseEventTitle("a".repeat(201)).ok, false);
  });

  it("requires a real calendar date in range", () => {
    assert.deepEqual(parseEventDate("2026-10-07"), { ok: true, value: "2026-10-07" });
    for (const bad of ["", "2026-02-30", "2026-10-07T10:00", "07/10/2026", "1999-12-31", "2101-01-01"]) {
      assert.equal(parseEventDate(bad).ok, false, bad);
    }
  });

  it("accepts only strict 24h HH:mm times", () => {
    assert.deepEqual(parseTime(""), { ok: true, value: null });
    assert.deepEqual(parseTime("09:30"), { ok: true, value: "09:30" });
    assert.deepEqual(parseTime("23:59"), { ok: true, value: "23:59" });
    for (const bad of ["9:30", "24:00", "12:60", "12:00:00", "10am", "12.30"]) {
      assert.equal(parseTime(bad).ok, false, bad);
    }
  });

  it("keeps start and end consistent; all-day drops any times", () => {
    assert.deepEqual(parseEventTimes(true, "10:00", "11:00"), { ok: true, value: { all_day: true, start_time: null, end_time: null } });
    assert.deepEqual(parseEventTimes(false, "10:00", ""), { ok: true, value: { all_day: false, start_time: "10:00", end_time: null } });
    assert.deepEqual(parseEventTimes(false, "10:00", "10:00"), { ok: true, value: { all_day: false, start_time: "10:00", end_time: "10:00" } });
    assert.equal(parseEventTimes(false, "", "").ok, false);
    assert.equal(parseEventTimes(false, "", "11:00").ok, false);
    assert.equal(parseEventTimes(false, "12:00", "11:59").ok, false);
  });

  it("reads only editable fields; source, external_id and user_id are ignored", () => {
    const parsed = parseEventDetails(
      form({
        title: " Crítica ",
        event_date: "2026-10-15",
        start_time: "09:30",
        end_time: "13:30",
        location: " Aula 3.2 ",
        description: "",
        project_id: id(1),
        source: "canvas",
        external_id: "asg-1",
        user_id: id(9),
      }),
    );
    assert.deepEqual(parsed, {
      ok: true,
      value: {
        title: "Crítica",
        description: null,
        event_date: "2026-10-15",
        all_day: false,
        start_time: "09:30",
        end_time: "13:30",
        location: "Aula 3.2",
        project_id: id(1),
      },
    });
  });

  it("treats the all_day checkbox as present-or-absent", () => {
    const parsed = parseEventDetails(form({ title: "Jornadas", event_date: "2026-10-09", all_day: "on", start_time: "10:00" }));
    assert.ok(parsed.ok && parsed.value.all_day && parsed.value.start_time === null);
  });

  it("validates the project reference and leaves it untouched when the field is absent", () => {
    assert.equal(parseEventDetails(form({ title: "x", event_date: "2026-10-09", all_day: "on", project_id: "astronomia" })).ok, false);
    const cleared = parseEventDetails(form({ title: "x", event_date: "2026-10-09", all_day: "on", project_id: "" }));
    assert.ok(cleared.ok && cleared.value.project_id === null);
    const untouched = parseEventDetails(form({ title: "x", event_date: "2026-10-09", all_day: "on" }));
    assert.ok(untouched.ok && !("project_id" in untouched.value));
  });

  it("validates event ids as UUIDs", () => {
    assert.equal(isEventId(id(1)), true);
    assert.equal(isEventId("ev-01"), false);
  });
});

const projects = [
  { id: id(1), name: "Taller de Proyectos" },
  { id: id(2), name: "Astronomía" },
];

function event(n: number, date: string, start: string | null, extra: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id: id(100 + n),
    title: `Evento ${n}`,
    description: null,
    event_date: date,
    start_time: start ? `${start}:00` : null,
    end_time: null,
    all_day: start === null,
    location: null,
    project_id: null,
    source: "manual",
    ...extra,
  };
}

function task(n: number, due: string | null, status = "pending", projectId: string | null = null): DeadlineTask {
  return { id: id(200 + n), title: `Tarea ${n}`, status, due_date: due, project_id: projectId };
}

describe("unified calendar items", () => {
  it("projects events with HH:mm times, project names and source", () => {
    const item = eventToItem(event(1, "2026-10-07", "11:00", { end_time: "11:30:00", location: "Despacho 2.14", project_id: id(1) }), new Map(projects.map((p) => [p.id, p.name])));
    assert.deepEqual(item, {
      itemType: "event",
      id: id(101),
      title: "Evento 1",
      date: "2026-10-07",
      startTime: "11:00",
      endTime: "11:30",
      allDay: false,
      location: "Despacho 2.14",
      projectName: "Taller de Proyectos",
      source: "manual",
    });
  });

  it("projects tasks with their real id and no invented time or place", () => {
    const item = taskToDeadlineItem(task(1, "2026-10-23", "done", id(2)), new Map(projects.map((p) => [p.id, p.name])));
    assert.deepEqual(item, { itemType: "task-deadline", id: id(201), title: "Tarea 1", date: "2026-10-23", projectName: "Astronomía", done: true });
    assert.equal(taskToDeadlineItem(task(2, null), new Map()), null);
  });

  it("merges both sources: deadlines, then all-day, then timed events by start", () => {
    const items = buildCalendarItems(
      [event(1, "2026-10-07", "13:00"), event(2, "2026-10-07", "09:00"), event(3, "2026-10-07", null), event(4, "2026-10-08", "08:00")],
      [task(1, "2026-10-07"), task(2, null)],
      projects,
    );
    assert.deepEqual(
      itemsOn(items, "2026-10-07").map((item) => `${item.itemType}:${item.title}`),
      ["task-deadline:Tarea 1", "event:Evento 3", "event:Evento 2", "event:Evento 1"],
    );
    assert.equal(items.length, 5);
    assert.deepEqual([...groupItemsByDate(items).keys()], ["2026-10-07", "2026-10-08"]);
  });

  it("an unknown project (e.g. not loaded) shows no name rather than an id", () => {
    const [item] = buildCalendarItems([event(1, "2026-10-07", "10:00", { project_id: id(9) })], [], projects);
    assert.equal(item.projectName, null);
  });
});

describe("upcoming deadlines", () => {
  it("keeps pending tasks with a date, overdue included, earliest first; never completed ones", () => {
    const items = upcomingDeadlines(
      [task(1, "2026-10-23"), task(2, "2026-10-01"), task(3, "2026-10-10", "done"), task(4, null), task(5, "2026-10-07", "pending", id(1))],
      projects,
    );
    assert.deepEqual(items.map((item) => [item.title, item.date, item.projectName]), [
      ["Tarea 2", "2026-10-01", null],
      ["Tarea 5", "2026-10-07", "Taller de Proyectos"],
      ["Tarea 1", "2026-10-23", null],
    ]);
  });
});

describe("calendar navigation", () => {
  const today = "2026-10-05";

  it("defaults to today's month and today", () => {
    assert.deepEqual(resolveCalendarView({}, today), { month: "2026-10-01", selected: "2026-10-05" });
  });

  it("keeps a valid day in the requested month", () => {
    assert.deepEqual(resolveCalendarView({ mes: "2026-11", dia: "2026-11-05" }, today), { month: "2026-11-01", selected: "2026-11-05" });
    assert.deepEqual(resolveCalendarView({ dia: "2026-12-24" }, today), { month: "2026-12-01", selected: "2026-12-24" });
  });

  it("selects the 1st when moving to another month, today when returning to the current one", () => {
    assert.deepEqual(resolveCalendarView({ mes: "2026-11" }, today), { month: "2026-11-01", selected: "2026-11-01" });
    assert.deepEqual(resolveCalendarView({ mes: "2026-10", dia: "2026-11-05" }, today), { month: "2026-10-01", selected: "2026-10-05" });
  });

  it("falls back on invalid or out-of-range params", () => {
    for (const params of [{ mes: "2026-13" }, { mes: "26-10" }, { mes: ["2026-11"] }, { dia: "2026-02-30" }, { mes: "1999-12" }, { dia: "2101-01-01" }]) {
      assert.deepEqual(resolveCalendarView(params, today), { month: "2026-10-01", selected: "2026-10-05" }, JSON.stringify(params));
    }
  });

  it("moves across year boundaries and computes month ends (leap years included)", () => {
    assert.equal(addMonths("2026-12", 1), "2027-01");
    assert.equal(addMonths("2026-01", -1), "2025-12");
    assert.equal(lastDayOfMonth("2026-10-01"), "2026-10-31");
    assert.equal(lastDayOfMonth("2028-02-01"), "2028-02-29");
    assert.equal(lastDayOfMonth("2026-02-01"), "2026-02-28");
  });

  it("builds month links and stops at the supported range", () => {
    assert.deepEqual(adjacentMonthHrefs("2026-10-01"), { previous: "/calendar?mes=2026-09", next: "/calendar?mes=2026-11" });
    assert.equal(adjacentMonthHrefs("2000-01-01").previous, null);
    assert.equal(adjacentMonthHrefs("2100-12-01").next, null);
    assert.equal(calendarHref({ month: "2026-10-01", selected: "2026-10-07" }, { nuevo: true }), "/calendar?mes=2026-10&dia=2026-10-07&nuevo=1");
    assert.equal(calendarHref({ month: "2026-10-07", selected: "2026-10-07" }, { editar: id(1) }), `/calendar?mes=2026-10&dia=2026-10-07&editar=${id(1)}`);
  });

  it("generates Monday-first weeks covering the month", () => {
    const weeks = buildMonthWeeks("2026-11-01");
    assert.equal(weeks[0][0].date, "2026-10-26");
    assert.equal(weeks[0][6].date, "2026-11-01");
    assert.ok(weeks.every((week) => week.length === 7));
    assert.equal(weeks.flat().filter((day) => day.inMonth).length, 30);
  });
});
