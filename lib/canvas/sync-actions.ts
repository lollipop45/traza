"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { revalidateTaskViews } from "@/lib/tasks/mutations";
import { runLeasedCanvasSync, syncLogLine } from "./auto-sync";
import { runCanvasSync, type CanvasSyncResult } from "./sync";
import { createCanvasSyncDeps, createLeasedSyncDeps } from "./sync-deps";

// Manual Canvas assignment sync. Both actions verify the TRAZA session and use the same engine and
// dependencies as the automatic sync (lib/canvas/sync-deps.ts): live Canvas courses read on the
// server, only linked courses found there, the user's ignore/include decisions, the same relevance
// rules. "Sincronizar Campus" also takes the per-user lease (so it never overlaps an automatic run)
// but skips the automatic cooldown. The browser sends nothing but the request itself. The result
// carries counts, titles and course/project names, plus the Canvas ids of listed assignments (only
// so "Importar" / "Ignorar" can name them back; never displayed): never tokens, URLs or raw Canvas
// responses.

const diagnostics = () => process.env.NODE_ENV !== "production";

/** Vista previa: reads Canvas and existing task ids; writes nothing (no lease, no sync state). */
export async function previewCanvasSync(): Promise<CanvasSyncResult> {
  await requireUser();
  return runCanvasSync(createCanvasSyncDeps(), "preview");
}

/** Sincronizar Campus: imports/updates tasks for verified linked courses. */
export async function syncCanvasAssignments(): Promise<CanvasSyncResult> {
  await requireUser();
  const result = await runLeasedCanvasSync(createLeasedSyncDeps(), "manual");
  if (diagnostics()) console.info(syncLogLine(result));
  revalidatePath("/projects/canvas");

  if (result.outcome === "already_running") {
    return { ok: false, error: "Campus ya se está sincronizando. Inténtalo de nuevo en un momento.", code: "unexpected" };
  }
  if (result.outcome === "no_linked_courses") {
    return { ok: false, error: "Vincula un curso a un proyecto para importar sus entregas.", code: "unexpected" };
  }
  if (!result.sync) return { ok: false, error: "No se ha podido sincronizar Campus. Inténtalo de nuevo más tarde.", code: result.errorCode ?? "unexpected" };
  if (result.sync.ok) revalidateTaskViews();
  return result.sync;
}
