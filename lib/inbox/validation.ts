import { parseProjectId } from "@/lib/projects/validation";
import { DEFAULT_TASK_PRIORITY } from "@/lib/tasks/types";
import { parseTitle, type TaskDetails } from "@/lib/tasks/validation";
import { charLength, formField, isUuid, type Parsed } from "@/lib/validation";
import {
  CAPTURE_CONTENT_MAX_LENGTH,
  CAPTURE_TITLE_MAX_LENGTH,
  isCaptureKind,
  isEntryKind,
  type CaptureKind,
  type EntryKind,
} from "./types";

// Server-side parsing of untrusted Inbox input. Only editable columns are read; id, user_id,
// source, external_id and timestamps are never taken from the browser.

/** Editable idea/note fields, named like their `public.inbox_items` columns. */
export type CaptureDetails = {
  kind: CaptureKind;
  title: string | null;
  content: string | null;
  /** Omitted when the form has no project field: the stored value is then left unchanged. */
  project_id?: string | null;
};

/** A composer submission: a task for public.tasks, or an idea/note for public.inbox_items. */
export type ParsedCapture = { kind: "task"; task: TaskDetails } | { kind: CaptureKind; item: CaptureDetails };

export function isInboxItemId(value: unknown): value is string {
  return isUuid(value);
}

export function parseEntryKind(raw: string): Parsed<EntryKind> {
  return isEntryKind(raw) ? { ok: true, value: raw } : { ok: false, error: "El tipo no es válido." };
}

export function parseCaptureKind(raw: string): Parsed<CaptureKind> {
  return isCaptureKind(raw) ? { ok: true, value: raw } : { ok: false, error: "El tipo no es válido." };
}

const EMPTY_CAPTURE = "Escribe algo antes de guardarlo.";
const CONTENT_TOO_LONG = `El texto no puede superar los ${CAPTURE_CONTENT_MAX_LENGTH} caracteres.`;

/**
 * Turns free composer text into an idea/note: the first line becomes the title and the rest the
 * content. A first line too long for a title keeps the whole text as content, with no title.
 */
export function splitCapture(raw: string): Parsed<{ title: string | null; content: string | null }> {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, error: EMPTY_CAPTURE };

  const newline = text.indexOf("\n");
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : text.slice(newline + 1).trim();

  if (charLength(firstLine) > CAPTURE_TITLE_MAX_LENGTH) {
    return charLength(text) > CAPTURE_CONTENT_MAX_LENGTH ? { ok: false, error: CONTENT_TOO_LONG } : { ok: true, value: { title: null, content: text } };
  }
  if (charLength(rest) > CAPTURE_CONTENT_MAX_LENGTH) return { ok: false, error: CONTENT_TOO_LONG };
  return { ok: true, value: { title: firstLine, content: rest || null } };
}

/** A task captured from the Inbox is one line: line breaks become spaces, then the task title rules apply. */
export function taskTitleFromCapture(raw: string): Parsed<string> {
  return parseTitle(raw.replace(/\s+/g, " "));
}

/** Reads the Inbox composer: `kind`, `text` and the optional `project_id`. */
export function parseCapture(formData: FormData): Parsed<ParsedCapture> {
  const kind = parseEntryKind(formField(formData, "kind"));
  if (!kind.ok) return kind;

  let projectId: string | null = null;
  if (formData.has("project_id")) {
    const parsedProject = parseProjectId(formField(formData, "project_id"));
    if (!parsedProject.ok) return parsedProject;
    projectId = parsedProject.value;
  }
  const text = formField(formData, "text");

  if (kind.value === "task") {
    if (!text.trim()) return { ok: false, error: EMPTY_CAPTURE };
    const title = taskTitleFromCapture(text);
    if (!title.ok) return title;
    // Same defaults as Home quick capture: normal priority, no due date.
    return {
      ok: true,
      value: { kind: "task", task: { title: title.value, due_date: null, priority: DEFAULT_TASK_PRIORITY, project_id: projectId } },
    };
  }

  const split = splitCapture(text);
  if (!split.ok) return split;
  return { ok: true, value: { kind: kind.value, item: { kind: kind.value, ...split.value, project_id: projectId } } };
}

function parseOptionalText(raw: string, max: number, error: string): Parsed<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return charLength(value) > max ? { ok: false, error } : { ok: true, value };
}

/** Reads the idea/note editor: kind, title, content and the optional project. */
export function parseCaptureDetails(formData: FormData): Parsed<CaptureDetails> {
  const kind = parseCaptureKind(formField(formData, "kind"));
  if (!kind.ok) return kind;
  const title = parseOptionalText(
    formField(formData, "title"),
    CAPTURE_TITLE_MAX_LENGTH,
    `El título no puede superar los ${CAPTURE_TITLE_MAX_LENGTH} caracteres.`,
  );
  if (!title.ok) return title;
  const content = parseOptionalText(formField(formData, "content"), CAPTURE_CONTENT_MAX_LENGTH, CONTENT_TOO_LONG);
  if (!content.ok) return content;
  if (!title.value && !content.value) return { ok: false, error: "Escribe un título o un contenido." };

  const details: CaptureDetails = { kind: kind.value, title: title.value, content: content.value };
  if (formData.has("project_id")) {
    const projectId = parseProjectId(formField(formData, "project_id"));
    if (!projectId.ok) return projectId;
    details.project_id = projectId.value;
  }
  return { ok: true, value: details };
}
