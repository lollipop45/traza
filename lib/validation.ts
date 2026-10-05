// Shared building blocks for server-side parsing of untrusted form input.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A form field as a string; missing fields and files become "". */
export function formField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Length in code points, as Postgres char_length() counts it. */
export function charLength(text: string): number {
  return [...text].length;
}
