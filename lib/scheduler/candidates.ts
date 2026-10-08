import "server-only";
import { readCanvasConfig } from "@/lib/canvas/env";
import { readGoogleCalendarConfig } from "@/lib/google-calendar/env";
import { readPushConfig } from "@/lib/notifications/env";
import { planNotifications } from "@/lib/notifications/planner";
import type { AdminClient } from "@/lib/supabase/admin";
import { canvasOwner, distinctUsers, isDeliveryOpen, isSyncDue, SCHEDULER_MAX_USERS, type DeliverySnapshot } from "./policy";
import type { CanvasCandidate, UserCandidates } from "./run";
import { createScheduledScope } from "./scope";
import { createScheduledNotificationStore } from "./stores/notifications";

// The scheduler's candidate queries, with the privileged client (lib/supabase/admin.ts): the ONLY
// place target user ids come from. READ-ONLY and bounded. Discovery reads only user ids and sync /
// connection metadata across users (never token ciphertext, push endpoints or keys); anything about
// one user's own data goes through that user's ScheduledScope. The engines that then run re-check
// everything through the database functions (the authority on leases, cooldowns and dedupe).

/** Reminders: users with at least one device whose planner has a reminder that can still be sent. */
export async function notificationCandidates(admin: AdminClient, now: number): Promise<UserCandidates> {
  if (!readPushConfig().ok) return { kind: "not_configured" };
  // Devices per user are few; 200 rows comfortably covers SCHEDULER_MAX_USERS users.
  const devices = await admin.from("push_subscriptions").select("user_id").order("created_at").limit(200);
  if (devices.error) return { kind: "unavailable" };
  const { userIds } = distinctUsers(devices.data, SCHEDULER_MAX_USERS);

  const due: string[] = [];
  for (const userId of userIds) {
    if (await hasOpenReminder(admin, userId, now)) due.push(userId);
  }
  return { kind: "ok", checked: userIds.length, due };
}

/** The existing planner, on this user's data only (read through the user's ScheduledScope). */
async function hasOpenReminder(admin: AdminClient, userId: string, now: number): Promise<boolean> {
  const store = createScheduledNotificationStore(createScheduledScope(admin, userId));
  const preferences = await store.loadPreferences();
  if (!preferences?.pushEnabled) return false;
  const data = await store.loadPlannerData(now);
  if (!data) return false;
  const plan = planNotifications({ now, preferences, tasks: data.tasks, events: data.events });
  if (plan.length === 0) return false;

  const keys = plan.map((planned) => planned.dedupeKey);
  const rows = await store.loadDeliveries(keys);
  if (!rows) return false;
  const byKey = new Map<string, DeliverySnapshot>(rows.map((row) => [row.dedupe_key, row]));
  return keys.some((key) => isDeliveryOpen(byKey.get(key) ?? null, now));
}

/**
 * Canvas: CANVAS_ACCESS_TOKEN is ONE person's token. It is applied only when exactly one TRAZA user
 * has Canvas course links; with several, scheduled Canvas sync is refused (interactive sync is
 * unchanged). Two bounded queries: "some user with links" and "another user with links".
 */
export async function canvasCandidate(admin: AdminClient, now: number): Promise<CanvasCandidate> {
  if (!readCanvasConfig().ok) return { kind: "not_configured" };
  const first = await admin.from("canvas_course_links").select("user_id").order("user_id").limit(1).maybeSingle();
  if (first.error) return { kind: "unavailable" };
  const firstUserId = first.data?.user_id ?? null;
  let another = false;
  if (firstUserId) {
    const other = await admin.from("canvas_course_links").select("user_id").neq("user_id", firstUserId).limit(1);
    if (other.error) return { kind: "unavailable" };
    another = other.data.length > 0;
  }
  const owner = canvasOwner(firstUserId, another);
  if (owner.kind === "none") return { kind: "no_users" };
  if (owner.kind === "multiple") return { kind: "multiple_users" };

  const state = await admin.from("canvas_sync_state").select("lease_until, next_eligible_at").eq("user_id", owner.userId).maybeSingle();
  if (state.error) return { kind: "unavailable" };
  return isSyncDue(state.data, now) ? { kind: "due", userId: owner.userId } : { kind: "not_due" };
}

/** Google: users with a live connection and a chosen calendar whose sync state is due. */
export async function googleCandidates(admin: AdminClient, now: number): Promise<UserCandidates> {
  if (!readGoogleCalendarConfig().ok) return { kind: "not_configured" };
  // Metadata columns only: the token ciphertext is never selected here.
  const connections = await admin
    .from("google_calendar_connections")
    .select("user_id, connected_at")
    .eq("status", "connected")
    .not("selected_calendar_id", "is", null)
    .order("user_id")
    .limit(SCHEDULER_MAX_USERS);
  if (connections.error) return { kind: "unavailable" };
  if (connections.data.length === 0) return { kind: "ok", checked: 0, due: [] };

  const states = await admin
    .from("google_calendar_sync_state")
    .select("user_id, lease_until, next_eligible_at, last_finished_at")
    .in(
      "user_id",
      connections.data.map((connection) => connection.user_id),
    );
  if (states.error) return { kind: "unavailable" };
  const byUser = new Map(states.data.map((state) => [state.user_id, state]));
  const due = connections.data
    .filter((connection) => isSyncDue(byUser.get(connection.user_id) ?? null, now, connection.connected_at))
    .map((connection) => connection.user_id);
  return { kind: "ok", checked: connections.data.length, due };
}
