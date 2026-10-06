"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { currentISODate } from "@/lib/calendar/dates";
import { readGoogleCalendarConfig } from "./env";
import { createConnectionStore } from "./store";
import { runGoogleSync, type GoogleSyncResult, type SyncMode } from "./sync";
import { createSyncStore } from "./sync-store";

// Manual Google Calendar sync. User-triggered only: no cron, no polling, nothing on page load.
// Both actions verify the TRAZA session (Server Actions also reject cross-origin requests); the
// browser sends nothing but the request. Results are aggregate counts plus the user's own titles
// and dates: never tokens, Google ids, raw Google responses or database errors.

async function run(mode: SyncMode): Promise<GoogleSyncResult> {
  const user = await requireUser();
  const configResult = readGoogleCalendarConfig();
  if (!configResult.ok) return { ok: false, error: "La integración con Google no está configurada." };

  let result: GoogleSyncResult;
  try {
    result = await runGoogleSync(
      {
        connection: {
          config: configResult.config,
          userId: user.id,
          store: createConnectionStore(user.id),
          fetch: (input, init) => fetch(input, init),
          now: Date.now,
        },
        store: createSyncStore(user.id),
        today: currentISODate(),
      },
      mode,
    );
  } catch {
    // Discarded, not logged: an exception here could carry request or response details.
    result = { ok: false, error: "No se ha podido completar la sincronización con Google Calendar. Inténtalo de nuevo." };
  }

  // A revoked access changes the section's state ("Acceso retirado"); a sync changes events.
  revalidatePath("/calendar");
  if (mode === "sync") {
    revalidatePath("/");
    revalidatePath("/projects");
  }
  return result;
}

/** "Vista previa Google": reads Google and TRAZA, plans, writes nothing. */
export async function previewGoogleCalendarSync(): Promise<GoogleSyncResult> {
  return run("preview");
}

/** "Sincronizar Google Calendar": carries out the same plan. */
export async function syncGoogleCalendar(): Promise<GoogleSyncResult> {
  return run("sync");
}
