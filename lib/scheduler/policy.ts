import { createHash, timingSafeEqual } from "node:crypto";

// Pure rules of the trusted background scheduler (no Next.js, no Supabase; tested directly).
//
// Wake-up: Supabase Cron calls POST /api/internal/scheduler every 5 minutes. That frequency is NOT
// reminder or sync semantics: each run only asks the existing engines whether something is due.
// The database (leases, cooldowns, delivery dedupe) stays the authority; the "is it due?" checks
// below mirror it only to avoid opening a user session when nothing can happen.

/** Supabase Cron schedule of the wake-up job (see the scheduler migration). */
export const SCHEDULER_CRON_SCHEDULE = "*/5 * * * *";

/** No new user is started after this much of an invocation has passed. */
export const SCHEDULER_NEW_WORK_MS = 120_000;
/** Every Canvas / Google request of a scheduled run must finish before this (from the start). */
export const SCHEDULER_HARD_DEADLINE_MS = 240_000;
/** Vercel function limit for the route (seconds); above the hard deadline, below the lease (5 min). */
export const SCHEDULER_MAX_DURATION_SECONDS = 300;
/** Users per integration per invocation (TRAZA v1.0 is personal; this only bounds the fan-out). */
export const SCHEDULER_MAX_USERS = 10;

// ---------------------------------------------------------------------------------------------
// Authentication: Authorization: Bearer <SCHEDULER_SECRET>. Nothing else is accepted (no query
// parameter, body or cookie). The secret is separate from every other credential.

/** At least 32 printable characters, e.g. 32 random bytes as base64url (43 characters). */
export function isSchedulerSecret(value: string): boolean {
  return value.length >= 32 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

/** SCHEDULER_SECRET, or null when absent or too weak. `env` is injectable for tests; never logged. */
export function readSchedulerSecret(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.SCHEDULER_SECRET?.trim();
  return value && isSchedulerSecret(value) ? value : null;
}

/** The token of an exact "Bearer <token>" Authorization header, or null. */
export function bearerToken(headers: Headers): string | null {
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Constant-time check of the bearer token against SCHEDULER_SECRET (both hashed first, so neither
 * the length nor the content leaks through timing). A missing or weak secret rejects everything,
 * with the same answer as a wrong token.
 */
export function isAuthorizedSchedulerRequest(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
  const expected = readSchedulerSecret(env);
  const provided = bearerToken(headers);
  if (!provided) return false;
  // Compared even without a configured secret, so both failures take the same time.
  const equal = timingSafeEqual(digest(provided), digest(expected ?? "\u0000not-configured"));
  return expected !== null && equal;
}

// ---------------------------------------------------------------------------------------------
// Due checks (mirrors of claim_canvas_sync / claim_google_calendar_sync / claim_notification_delivery).

const time = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);

export type SyncStateSnapshot = {
  lease_until: string | null;
  next_eligible_at: string | null;
  last_finished_at?: string | null;
};

/**
 * Whether an automatic run could be claimed now: no live lease and the cooldown has passed (for
 * Google also: the connection was re-established after the last run). No state yet → due.
 */
export function isSyncDue(state: SyncStateSnapshot | null, now: number, reconnectedAt: string | null = null): boolean {
  if (!state) return true;
  if (state.lease_until && time(state.lease_until) > now) return false;
  if (!state.next_eligible_at || time(state.next_eligible_at) <= now) return true;
  if (!reconnectedAt || !state.last_finished_at) return false;
  return time(reconnectedAt) > time(state.last_finished_at);
}

export type DeliverySnapshot = {
  dedupe_key: string;
  status: string;
  failure_code: string | null;
  attempts: number;
  updated_at: string;
};

/** Pending deliveries older than this may be taken over (a crashed sender). */
export const STALE_PENDING_MS = 10 * 60 * 1000;
export const MAX_DELIVERY_ATTEMPTS = 3;

/** Whether a reminder with this delivery row (or none) could still be claimed and sent. */
export function isDeliveryOpen(row: DeliverySnapshot | null, now: number): boolean {
  if (!row) return true;
  if (row.attempts >= MAX_DELIVERY_ATTEMPTS) return false;
  if (row.status === "failed") return row.failure_code === "temporary_error";
  if (row.status === "pending") return time(row.updated_at) < now - STALE_PENDING_MS;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Canvas: ONE server-wide personal token (CANVAS_ACCESS_TOKEN). It belongs to one person, so a
// scheduled run may only ever apply it to one TRAZA user: the only user with Canvas course links.

export type CanvasOwner = { kind: "none" } | { kind: "single"; userId: string } | { kind: "multiple" };

/** From "a user with links" + "another user with links exists" (both bounded queries). */
export function canvasOwner(firstUserId: string | null, anotherUserExists: boolean): CanvasOwner {
  if (!firstUserId) return { kind: "none" };
  if (anotherUserExists) return { kind: "multiple" };
  return { kind: "single", userId: firstUserId };
}

/** Distinct ids in first-seen order, at most `limit`, plus whether more existed. */
export function distinctUsers(rows: { user_id: string }[], limit: number = SCHEDULER_MAX_USERS): { userIds: string[]; truncated: boolean } {
  const seen: string[] = [];
  for (const row of rows) {
    if (seen.includes(row.user_id)) continue;
    if (seen.length === limit) return { userIds: seen, truncated: true };
    seen.push(row.user_id);
  }
  return { userIds: seen, truncated: false };
}
