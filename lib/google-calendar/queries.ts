import "server-only";
import { requireUser } from "@/lib/auth/session";
import { readGoogleCalendarConfig } from "./env";
import { createConnectionStore } from "./store";
import type { GoogleConnectionStatus } from "./types";

// Server-only entry point for the Calendar page. Reads metadata only (no Google call, no tokens),
// so rendering /calendar never depends on Google being reachable.

export async function getGoogleCalendarStatus(): Promise<GoogleConnectionStatus> {
  const user = await requireUser();
  if (!readGoogleCalendarConfig().ok) return { state: "not-configured" };
  const loaded = await createConnectionStore(user.id).loadMetadata();
  if (!loaded.ok) return { state: "error" };
  const { metadata } = loaded;
  if (!metadata) return { state: "disconnected" };
  return {
    state: metadata.status === "connected" ? "connected" : "revoked",
    accountEmail: metadata.accountEmail,
    calendarName: metadata.selectedCalendarName,
  };
}
