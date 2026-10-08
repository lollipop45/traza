import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { runLeasedCanvasSync, syncLogLine } from "@/lib/canvas/auto-sync";
import { autoSyncResponse, isSameOriginRequest } from "@/lib/canvas/auto-sync-request";
import { createLeasedSyncDeps } from "@/lib/canvas/sync-deps";
import { revalidateTaskViews } from "@/lib/tasks/mutations";

// Automatic, opportunistic Canvas sync for the SIGNED-IN user, called by CanvasAutoSyncTrigger while
// the private app is open. POST only (no GET handler: a link or an <img> can never trigger it),
// same-origin only, and the user comes exclusively from the verified session: the request body is
// never read. The database decides whether a run is due (cooldown) and lets only one run per user
// at a time (lease); most calls return "not_due" without touching Canvas.
//
// This is NOT the scheduler: it never acts for a user who is not using TRAZA. The trusted scheduler
// (POST /api/internal/scheduler) reuses the same engine with its own authorization.

export const dynamic = "force-dynamic";

const diagnostics = () => process.env.NODE_ENV !== "production";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request.headers)) return json({ error: "forbidden" }, 403);
  const user = await getSessionUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const result = await runLeasedCanvasSync(createLeasedSyncDeps(), "automatic");
  // Development only, safe metadata (enums, counts, duration). Quiet for the cheap "not due" checks.
  if (diagnostics() && result.outcome !== "not_due") console.info(syncLogLine(result));

  const response = autoSyncResponse(result);
  if (response.changed) {
    revalidateTaskViews();
    revalidatePath("/projects/canvas");
  }
  return json(response);
}
