import "server-only";
import { currentISODate } from "@/lib/calendar/dates";
import type { LeasedGoogleSyncDeps } from "./auto-sync";
import { readGoogleCalendarConfig, type GoogleCalendarConfig } from "./env";
import { withGoogleRetries } from "./http";
import { createConnectionStore } from "./store";
import type { GoogleSyncDeps } from "./sync";
import { GOOGLE_SYNC_DEADLINE_MS, type GoogleSyncTrigger } from "./sync-policy";
import { createGoogleSyncStateStore } from "./sync-state-store";
import { createSyncStore } from "./sync-store";

// The real dependencies of the one Google sync engine, shared by "Vista previa Google",
// "Sincronizar Google Calendar" and the automatic endpoint, so all of them read Google and write
// TRAZA the same way. Server-only: callers must have verified the session; `userId` is that verified
// user (RLS pins every row to them as well). Google requests get bounded retries and a run deadline.

export function createGoogleSyncDeps(userId: string, config: GoogleCalendarConfig, options: { trigger?: GoogleSyncTrigger | "preview" } = {}): GoogleSyncDeps {
  const fetchFn = withGoogleRetries((input, init) => fetch(input, init), { deadline: Date.now() + GOOGLE_SYNC_DEADLINE_MS });
  return {
    connection: {
      config,
      userId,
      store: createConnectionStore(userId),
      fetch: fetchFn,
      now: Date.now,
      // An automatic run never wipes credentials it cannot decrypt (e.g. a changed key).
      keepUnreadableCredentials: options.trigger === "automatic",
    },
    store: createSyncStore(userId),
    today: currentISODate(),
  };
}

/** Pre-checks + lease + state + engine, for a run that writes (manual or automatic). */
export function createLeasedGoogleSyncDeps(userId: string, trigger: GoogleSyncTrigger): LeasedGoogleSyncDeps {
  const configResult = readGoogleCalendarConfig();
  const connectionStore = createConnectionStore(userId);
  return {
    configured: configResult.ok,
    loadMetadata: () => connectionStore.loadMetadata(),
    state: createGoogleSyncStateStore(),
    createSync: () => {
      if (!configResult.ok) throw new Error("Google is not configured");
      return createGoogleSyncDeps(userId, configResult.config, { trigger });
    },
    now: Date.now,
  };
}
