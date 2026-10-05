import { isValidISODate } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { DEFAULT_TASK_PRIORITY, TASK_TITLE_MAX_LENGTH, isTaskPriority, type TaskPriority } from "./types";

// Server-side parsing of untrusted form input. Only the editable task fields are ever read;
// anything else the browser sends (user_id, source, project_id, …) is ignored.

/** Editable task fields, named like their `public.tasks` columns. */
export type TaskDetails = {
  title: string;
  due_date: ISODate | null;
  priority: TaskPriority;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export function parseTitle(raw: string): Parsed<string> {
  const title = raw.trim();
  if (!title) return { ok: false, error: "Escribe la tarea antes de guardarla." };
  // Count code points, as Postgres char_length() does.
  if ([...title].length > TASK_TITLE_MAX_LENGTH) {
    return { ok: false, error: `La tarea no puede superar los ${TASK_TITLE_MAX_LENGTH} caracteres.` };
  }
  return { ok: true, value: title };
}

/** "" → no date. Otherwise a real calendar date (rejects 2026-02-30) within a sane range. */
export function parseDueDate(raw: string): Parsed<ISODate | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (!isValidISODate(value) || value < "2000-01-01" || value > "2100-12-31") {
    return { ok: false, error: "La fecha no es válida." };
  }
  return { ok: true, value };
}

export function parsePriority(raw: string): Parsed<TaskPriority> {
  if (!raw) return { ok: true, value: DEFAULT_TASK_PRIORITY };
  return isTaskPriority(raw) ? { ok: true, value: raw } : { ok: false, error: "La prioridad no es válida." };
}

/** Reads `title`, `due_date` and `priority` from a task form. */
export function parseTaskDetails(formData: FormData): Parsed<TaskDetails> {
  const title = parseTitle(field(formData, "title"));
  if (!title.ok) return title;
  const dueDate = parseDueDate(field(formData, "due_date"));
  if (!dueDate.ok) return dueDate;
  const priority = parsePriority(field(formData, "priority"));
  if (!priority.ok) return priority;
  return { ok: true, value: { title: title.value, due_date: dueDate.value, priority: priority.value } };
}
