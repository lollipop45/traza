// What the Campus page says about the automatic sync. Pure: built from the caller's
// canvas_sync_state row and the current instant. Shows states and times only, never error details.

export type SyncStateRow = {
  lease_until: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_result: string | null;
  last_review_count: number;
};

export type SyncStatusLabel = "ACTUALIZADO" | "SIN SINCRONIZAR" | "EN CURSO" | "REVISAR CONEXIÓN" | "ERROR TEMPORAL";

export type SyncStatusView = {
  status: SyncStatusLabel;
  /** "Hace 12 min", or "Nunca". */
  lastSync: string;
  /** Review items found by the last run (never auto-approved). */
  reviewCount: number;
};

const time = (value: string | null) => (value ? Date.parse(value) : Number.NaN);

/** "Hace un momento" · "Hace 12 min" · "Hace 3 h" · "Hace 2 días". */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Hace un momento";
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Hace 1 día" : `Hace ${days} días`;
}

export function syncStatusView(row: SyncStateRow | null, now: number): SyncStatusView {
  const success = time(row?.last_success_at ?? null);
  const lastSync = Number.isFinite(success) ? relativeTime(success, now) : "Nunca";
  const reviewCount = row && Number.isFinite(row.last_review_count) ? Math.max(0, row.last_review_count) : 0;

  let status: SyncStatusLabel;
  if (!row) status = "SIN SINCRONIZAR";
  else if (time(row.lease_until) > now) status = "EN CURSO";
  else if (row.last_result === "auth_error") status = "REVISAR CONEXIÓN";
  else if (row.last_result === "temporary_error") status = "ERROR TEMPORAL";
  else if (row.last_result === "success" || row.last_result === "no_linked_courses") status = "ACTUALIZADO";
  else status = "SIN SINCRONIZAR";

  return { status, lastSync, reviewCount };
}
