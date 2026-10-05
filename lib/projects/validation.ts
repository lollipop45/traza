import { charLength, formField, isUuid, type Parsed } from "@/lib/validation";
import {
  DEFAULT_PROJECT_STATUS,
  PROJECT_AREA_MAX_LENGTH,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  isProjectStatus,
  type ProjectStatus,
} from "./types";

// Server-side parsing of untrusted project form input. Only the editable columns are read;
// id, user_id, source and timestamps are never taken from the browser.

/** Fields set when creating a project; progress starts at the database default (0). */
export type NewProjectDetails = {
  name: string;
  area: string | null;
  description: string | null;
  status: ProjectStatus;
};

/** Fields an edit may change. */
export type ProjectDetails = NewProjectDetails & { progress: number };

export function isProjectId(value: unknown): value is string {
  return isUuid(value);
}

/**
 * A project reference on a task or event: "" → no project, otherwise a UUID. Whether that project
 * exists and belongs to the same user is enforced by the database (composite owner foreign keys),
 * never trusted to this check.
 */
export function parseProjectId(raw: string): Parsed<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return isUuid(value) ? { ok: true, value: value.toLowerCase() } : { ok: false, error: "El proyecto no es válido." };
}

export function parseProjectName(raw: string): Parsed<string> {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Escribe el nombre del proyecto." };
  if (charLength(name) > PROJECT_NAME_MAX_LENGTH) {
    return { ok: false, error: `El nombre no puede superar los ${PROJECT_NAME_MAX_LENGTH} caracteres.` };
  }
  return { ok: true, value: name };
}

/** Optional free text: trimmed, "" → null, capped at `max`. */
function parseOptionalText(raw: string, max: number, error: string): Parsed<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return charLength(value) > max ? { ok: false, error } : { ok: true, value };
}

export function parseArea(raw: string): Parsed<string | null> {
  return parseOptionalText(raw, PROJECT_AREA_MAX_LENGTH, `El área no puede superar los ${PROJECT_AREA_MAX_LENGTH} caracteres.`);
}

export function parseDescription(raw: string): Parsed<string | null> {
  return parseOptionalText(
    raw,
    PROJECT_DESCRIPTION_MAX_LENGTH,
    `La descripción no puede superar los ${PROJECT_DESCRIPTION_MAX_LENGTH} caracteres.`,
  );
}

export function parseProjectStatus(raw: string): Parsed<ProjectStatus> {
  if (!raw) return { ok: true, value: DEFAULT_PROJECT_STATUS };
  return isProjectStatus(raw) ? { ok: true, value: raw } : { ok: false, error: "El estado no es válido." };
}

/** Whole number 0–100. No decimals, signs, exponents or blanks. */
export function parseProgress(raw: string): Parsed<number> {
  const value = raw.trim();
  const progress = Number(value);
  if (!/^\d{1,3}$/.test(value) || progress > 100) {
    return { ok: false, error: "El avance debe ser un número entero entre 0 y 100." };
  }
  return { ok: true, value: progress };
}

export function parseNewProject(formData: FormData): Parsed<NewProjectDetails> {
  const name = parseProjectName(formField(formData, "name"));
  if (!name.ok) return name;
  const area = parseArea(formField(formData, "area"));
  if (!area.ok) return area;
  const description = parseDescription(formField(formData, "description"));
  if (!description.ok) return description;
  const status = parseProjectStatus(formField(formData, "status"));
  if (!status.ok) return status;
  return { ok: true, value: { name: name.value, area: area.value, description: description.value, status: status.value } };
}

export function parseProjectDetails(formData: FormData): Parsed<ProjectDetails> {
  const base = parseNewProject(formData);
  if (!base.ok) return base;
  const progress = parseProgress(formField(formData, "progress"));
  if (!progress.ok) return progress;
  return { ok: true, value: { ...base.value, progress: progress.value } };
}
