"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { googleSyncLogLine, runLeasedGoogleSync } from "./auto-sync";
import { readGoogleCalendarConfig } from "./env";
import { runGoogleSync, type GoogleSyncResult } from "./sync";
import { createGoogleSyncDeps, createLeasedGoogleSyncDeps } from "./sync-deps";

// Manual Google Calendar sync. Both actions verify the TRAZA session (Server Actions also reject
// cross-origin requests) and use the same engine and dependencies as the automatic sync
// (lib/google-calendar/sync-deps.ts). "Sincronizar Google Calendar" also takes the per-user lease
// (so it never overlaps an automatic run) but skips the automatic cooldown. The browser sends
// nothing but the request. Results are aggregate counts plus the user's own titles and dates:
// never tokens, Google ids, raw Google responses or database errors.

const diagnostics = () => process.env.NODE_ENV !== "production";
const NOT_CONFIGURED: GoogleSyncResult = { ok: false, error: "La integración con Google no está configurada.", code: "unexpected" };
const FAILED: GoogleSyncResult = { ok: false, error: "No se ha podido completar la sincronización con Google Calendar. Inténtalo de nuevo.", code: "unexpected" };

/** "Vista previa Google": reads Google and TRAZA, plans, writes nothing (no lease, no sync state). */
export async function previewGoogleCalendarSync(): Promise<GoogleSyncResult> {
  const user = await requireUser();
  const configResult = readGoogleCalendarConfig();
  if (!configResult.ok) return NOT_CONFIGURED;
  let result: GoogleSyncResult;
  try {
    result = await runGoogleSync(createGoogleSyncDeps(user.id, configResult.config, { trigger: "preview" }), "preview");
  } catch {
    // Discarded, not logged: an exception here could carry request or response details.
    result = FAILED;
  }
  // A revoked access changes the section's state ("Acceso retirado").
  revalidatePath("/calendar");
  return result;
}

/** "Sincronizar Google Calendar": carries out the same plan, under the lease. */
export async function syncGoogleCalendar(): Promise<GoogleSyncResult> {
  const user = await requireUser();
  if (!readGoogleCalendarConfig().ok) return NOT_CONFIGURED;
  const result = await runLeasedGoogleSync(createLeasedGoogleSyncDeps(user.id, "manual"), "manual");
  if (diagnostics()) console.info(googleSyncLogLine(result));

  revalidatePath("/calendar");
  revalidatePath("/");
  revalidatePath("/projects");
  if (result.outcome === "already_running") {
    return { ok: false, error: "Google Calendar ya se está sincronizando. Inténtalo de nuevo en un momento.", code: "unexpected" };
  }
  if (result.sync) return result.sync;
  if (result.outcome === "not_connected") return { ok: false, error: "Google Calendar no está conectado.", code: "not_connected" };
  if (result.outcome === "no_calendar") return { ok: false, error: "Elige primero el calendario de Google que usará TRAZA.", code: "no_calendar" };
  if (result.outcome === "reconnect_required") return { ok: false, error: "Google ha retirado el acceso de TRAZA. Vuelve a conectar Google Calendar.", code: "reconnect_required" };
  return FAILED;
}
