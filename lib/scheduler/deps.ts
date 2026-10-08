import "server-only";
import { runLeasedCanvasSync } from "@/lib/canvas/auto-sync";
import { runLeasedGoogleSync } from "@/lib/google-calendar/auto-sync";
import { runDueNotifications } from "@/lib/notifications/run";
import { createAdminClient } from "@/lib/supabase/admin";
import { canvasCandidate, googleCandidates, notificationCandidates } from "./candidates";
import { SCHEDULER_HARD_DEADLINE_MS } from "./policy";
import type { SchedulerDeps } from "./run";
import { createScheduledDependencies } from "./scoped-deps";

// The real dependencies of one scheduler invocation. Only POST /api/internal/scheduler builds them,
// after the SCHEDULER_SECRET check. Candidate queries pick the users; each user's work runs through
// createScheduledDependencies (secret-key client, explicitly scoped to that user) with the EXISTING
// engines and the "automatic" trigger, so the cooldowns apply and the leases are the same ones the
// browser and the manual buttons use. No user session, cookie or Auth sign-in is involved.

/** Null when the privileged client is not configured (nothing is done then). */
export function createSchedulerDeps(): SchedulerDeps | null {
  const admin = createAdminClient();
  if (!admin) return null;
  const deadline = Date.now() + SCHEDULER_HARD_DEADLINE_MS;
  const forUser = (userId: string) => createScheduledDependencies({ admin, userId, deadline });

  return {
    now: Date.now,
    notifications: {
      candidates: () => notificationCandidates(admin, Date.now()),
      run: (userId) => runDueNotifications(forUser(userId).notifications),
    },
    canvas: {
      candidate: () => canvasCandidate(admin, Date.now()),
      run: (userId) => runLeasedCanvasSync(forUser(userId).canvas, "automatic"),
    },
    google: {
      candidates: () => googleCandidates(admin, Date.now()),
      run: (userId) => runLeasedGoogleSync(forUser(userId).google, "automatic"),
    },
  };
}
