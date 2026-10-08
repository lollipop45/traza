import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { createNotificationRunDeps } from "@/lib/notifications/deps";
import { PUSH_HEADER } from "@/lib/notifications/request";
import { runDueNotifications } from "@/lib/notifications/run";
import { isSameOriginRequest } from "@/lib/security/same-origin";

// Opportunistic reminder check for the SIGNED-IN user while TRAZA is open (NotificationCheckTrigger):
// runs the planner and delivers any reminder that is due and not yet sent (durable dedupe in the
// database). POST only, same-origin only, session required; the body is never read.
//
// Scheduled delivery while TRAZA is closed will be enabled in Prompt 23 (trusted production
// scheduler), reusing lib/notifications/run.ts unchanged.

export const dynamic = "force-dynamic";

const diagnostics = () => process.env.NODE_ENV !== "production";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request.headers, PUSH_HEADER)) return json({ ok: false }, 403);
  const user = await getSessionUser();
  if (!user) return json({ ok: false }, 401);

  const result = await runDueNotifications(createNotificationRunDeps(user.id));
  if (diagnostics() && result.planned > 0) {
    console.info(`TRAZA notifications: outcome=${result.outcome} planned=${result.planned} sent=${result.sent} skipped=${result.skipped} failed=${result.failed} duplicates=${result.duplicates}`);
  }
  return json({ outcome: result.outcome });
}
