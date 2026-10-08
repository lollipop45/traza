import { NextResponse, type NextRequest } from "next/server";
import { createSchedulerDeps } from "@/lib/scheduler/deps";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler/policy";
import { runScheduler, schedulerLogLine } from "@/lib/scheduler/run";

// TRAZA's trusted background scheduler. Server-to-server only: Supabase Cron (pg_cron + pg_net)
// calls it every 5 minutes with `Authorization: Bearer <SCHEDULER_SECRET>`. It keeps reminders,
// Canvas and Google working while TRAZA is closed by running the existing engines for the users
// that have something due (lib/scheduler/).
//
// - POST only; the secret is accepted ONLY in the Authorization header (never a query parameter,
//   body or cookie). The body is never read; no cookie or user session is used.
// - No same-origin check: pg_net is a legitimate cross-origin caller. The secret is the gate.
// - A missing/invalid secret and a missing SCHEDULER_SECRET both get the same 401.
// - The response and the log line carry aggregate counts and enums only.
// The proxy lets this path through without a session (lib/auth/routes.ts).

export const dynamic = "force-dynamic";
// = SCHEDULER_MAX_DURATION_SECONDS (a literal, for the build; tests/unit/scheduler.test.ts checks it).
export const maxDuration = 300;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedSchedulerRequest(request.headers)) return json({ ok: false, error: "unauthorized" }, 401);

  const deps = createSchedulerDeps();
  if (!deps) return json({ ok: false, error: "not_configured" }, 503);

  const result = await runScheduler(deps);
  console.info(schedulerLogLine(result));
  return json(result);
}
