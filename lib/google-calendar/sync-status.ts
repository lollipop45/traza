import { relativeTime } from "@/lib/canvas/sync-status";
import type { GoogleConnectionStatus } from "./types";

// What the Calendar's Google section says about the automatic sync. Pure: built from the
// connection metadata, the caller's google_calendar_sync_state row and the current instant. States
// and times only, never error details.

export type GoogleSyncStateRow = {
  lease_until: string | null;
  last_success_at: string | null;
  last_result: string | null;
};

export type GoogleSyncStatusLabel =
  | "ACTUALIZADO"
  | "SIN SINCRONIZAR"
  | "EN CURSO"
  | "NO CONECTADO"
  | "REQUIERE RECONECTAR"
  | "ERROR TEMPORAL"
  | "NO CONFIGURADO";

export type GoogleSyncStatusView = {
  status: GoogleSyncStatusLabel;
  /** "Hace 12 min", or "Nunca". */
  lastSync: string;
  /** The last run found that the user must reconnect (even if the connection still says connected). */
  reconnect: boolean;
};

const time = (value: string | null) => (value ? Date.parse(value) : Number.NaN);

export function googleSyncStatusView(connection: GoogleConnectionStatus, row: GoogleSyncStateRow | null, now: number): GoogleSyncStatusView {
  const success = time(row?.last_success_at ?? null);
  const lastSync = Number.isFinite(success) ? relativeTime(success, now) : "Nunca";
  const view = (status: GoogleSyncStatusLabel, reconnect = false): GoogleSyncStatusView => ({ status, lastSync, reconnect });

  if (connection.state === "not-configured") return view("NO CONFIGURADO");
  if (connection.state === "disconnected") return view("NO CONECTADO");
  if (connection.state === "revoked") return view("REQUIERE RECONECTAR", true);
  if (connection.state === "error") return view("ERROR TEMPORAL");
  if (!connection.calendarName || !row) return view("SIN SINCRONIZAR");
  if (time(row.lease_until) > now) return view("EN CURSO");
  switch (row.last_result) {
    case "success":
      return view("ACTUALIZADO");
    case "reconnect_required":
      return view("REQUIERE RECONECTAR", true);
    case "rate_limited":
    case "temporary_error":
    case "unexpected":
      return view("ERROR TEMPORAL");
    default:
      return view("SIN SINCRONIZAR");
  }
}
