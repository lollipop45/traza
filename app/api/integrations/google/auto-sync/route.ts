import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { googleSyncLogLine, runLeasedGoogleSync } from "@/lib/google-calendar/auto-sync";
import { GOOGLE_AUTO_SYNC_HEADER, googleAutoSyncResponse } from "@/lib/google-calendar/auto-sync-request";
import { createLeasedGoogleSyncDeps } from "@/lib/google-calendar/sync-deps";
import { isSameOriginRequest } from "@/lib/security/same-origin";

// Automatic, opportunistic Google Calendar sync for the SIGNED-IN user, called by
// GoogleCalendarAutoSyncTrigger while the private app is open. POST only, same-origin only, and the
// user comes exclusively from the verified session: the request body is never read, so the browser
// cannot choose a user, calendar, event, project or token. The connection and the calendar are the
// ones stored for that user. The database decides whether a run is due (cooldown) and lets only one
// run per user at a time (lease); most calls return "not_due" without touching Google.
//
// This is NOT the scheduler: it never acts for a user who is not using TRAZA. The trusted scheduler
// (POST /api/internal/scheduler) reuses the same engine with its own authorization.

export const dynamic = "force-dynamic";

const diagnostics = () => process.env.NODE_ENV !== "production";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request.headers, GOOGLE_AUTO_SYNC_HEADER)) return json({ error: "forbidden" }, 403);
  const user = await getSessionUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const result = await runLeasedGoogleSync(createLeasedGoogleSyncDeps(user.id, "automatic"), "automatic");
  // Development only, safe metadata (enums, counts, duration). Quiet for the cheap checks.
  if (diagnostics() && result.outcome !== "not_due" && result.outcome !== "already_running") console.info(googleSyncLogLine(result));

  const response = googleAutoSyncResponse(result);
  if (response.changed) {
    revalidatePath("/calendar");
    revalidatePath("/");
    revalidatePath("/projects");
  }
  return json(response);
}
