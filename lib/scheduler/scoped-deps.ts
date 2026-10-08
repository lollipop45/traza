import "server-only";
import type { LeasedSyncDeps } from "@/lib/canvas/auto-sync";
import type { LeasedGoogleSyncDeps } from "@/lib/google-calendar/auto-sync";
import type { NotificationRunDeps } from "@/lib/notifications/run";
import type { AdminClient } from "@/lib/supabase/admin";
import { createScheduledScope } from "./scope";
import { createScheduledCanvasDeps } from "./stores/canvas";
import { createScheduledGoogleDeps } from "./stores/google";
import { createScheduledNotificationDeps } from "./stores/notifications";

// THE factory for scheduled work on one user. `userId` comes only from the scheduler's own
// candidate queries (lib/scheduler/candidates.ts) — never from a request. Every dependency below is
// derived from one ScheduledScope bound to that user, so the engines (runDueNotifications,
// runLeasedCanvasSync, runLeasedGoogleSync — unchanged) can only see and change that user's data.
// No Supabase Auth session is created: this is explicitly scoped system work with the secret key.

export type ScheduledDependencies = {
  userId: string;
  notifications: NotificationRunDeps;
  canvas: LeasedSyncDeps;
  google: LeasedGoogleSyncDeps;
};

export function createScheduledDependencies({ admin, userId, deadline }: { admin: AdminClient; userId: string; deadline: number }): ScheduledDependencies {
  const scope = createScheduledScope(admin, userId);
  return {
    userId: scope.userId,
    notifications: createScheduledNotificationDeps(scope),
    canvas: createScheduledCanvasDeps(scope, { deadline }),
    google: createScheduledGoogleDeps(scope, { deadline }),
  };
}
