import { isValidISODate } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { parseProjectId } from "@/lib/projects/validation";
import { charLength, formField, isUuid, type Parsed } from "@/lib/validation";
import { DEFAULT_TASK_PRIORITY, TASK_TITLE_MAX_LENGTH, isTaskPriority, type TaskPriority } from "./types";

// Server-side parsing of untrusted form input. Only the editable task fields are ever read;
// anything else the browser sends (user_id, source, …) is ignored.

export type { Parsed } from "@/lib/validation";
export { parseProjectId } from "@/lib/projects/validation";

/** Editable task fields, named like their `public.tasks` columns. */
export type TaskDetails = {
  title: string;
  due_date: ISODate | null;
  priority: TaskPriority;
  /** Omitted when the form has no project field: the stored value is then left unchanged. */
  project_id?: string | null;
};

export function isTaskId(value: unknown): value is string {
  return isUuid(value);
}

export function parseTitle(raw: string): Parsed<string> {
  const title = raw.trim();
  if (!title) return { ok: false, error: "Escribe la tarea antes de guardarla." };
  if (charLength(title) > TASK_TITLE_MAX_LENGTH) {
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

/**
 * Reads `title`, `due_date`, `priority` and `project_id` from a task form. A form without a
 * `project_id` field (e.g. projects could not be loaded) never clears an existing assignment.
 */
export function parseTaskDetails(formData: FormData): Parsed<TaskDetails> {
  const title = parseTitle(formField(formData, "title"));
  if (!title.ok) return title;
  const dueDate = parseDueDate(formField(formData, "due_date"));
  if (!dueDate.ok) return dueDate;
  const priority = parsePriority(formField(formData, "priority"));
  if (!priority.ok) return priority;
  const details: TaskDetails = { title: title.value, due_date: dueDate.value, priority: priority.value };
  if (formData.has("project_id")) {
    const projectId = parseProjectId(formField(formData, "project_id"));
    if (!projectId.ok) return projectId;
    details.project_id = projectId.value;
  }
  return { ok: true, value: details };
}
