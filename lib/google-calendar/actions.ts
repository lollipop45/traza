"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import {
  accessFailureMessage,
  disconnect,
  discoverCalendars,
  selectCalendar,
  type CalendarOption,
  type ConnectionDeps,
} from "./connection";
import { OAUTH_COOKIE_NAME, oauthCookieOptions } from "./cookie";
import { readGoogleCalendarConfig } from "./env";
import { authorizationUrl, createPendingAuthorization, sealPendingAuthorization } from "./oauth";
import { createConnectionStore } from "./store";

// Server Actions for the Google Calendar connection. Each verifies the TRAZA session first (Server
// Actions also reject cross-origin requests). They return Spanish messages and calendar names/ids
// only: never tokens, the client secret or raw Google responses.

const NOT_CONFIGURED = "La integración con Google no está configurada.";

async function connectionDeps(): Promise<ConnectionDeps | null> {
  const user = await requireUser();
  const configResult = readGoogleCalendarConfig();
  if (!configResult.ok) return null;
  return { config: configResult.config, userId: user.id, store: createConnectionStore(user.id), fetch: (input, init) => fetch(input, init), now: Date.now };
}

/** "Conectar Google Calendar": stores the sealed state cookie and sends the browser to Google. */
export async function startGoogleCalendarConnection(): Promise<void> {
  const user = await requireUser();
  const configResult = readGoogleCalendarConfig();
  if (!configResult.ok) redirect("/calendar?google=no-configurado");
  const { config } = configResult;

  const pending = createPendingAuthorization(user.id);
  (await cookies()).set(OAUTH_COOKIE_NAME, sealPendingAuthorization(pending, config.keyring), oauthCookieOptions(config.redirectUri));
  redirect(authorizationUrl(config, pending));
}

export type CalendarListState =
  | { ok: true; calendars: CalendarOption[]; selectedId: string | null; notOwned: number }
  | { ok: false; error: string };

/** The writable calendars of the connected account (live from Google). */
export async function listGoogleCalendars(): Promise<CalendarListState> {
  const deps = await connectionDeps();
  if (!deps) return { ok: false, error: NOT_CONFIGURED };
  const result = await discoverCalendars(deps);
  if (!result.ok) {
    if (result.kind === "revoked") revalidatePath("/calendar");
    return { ok: false, error: accessFailureMessage(result.kind) };
  }
  if (result.calendars.length === 0) return { ok: false, error: "No hay calendarios tuyos en los que TRAZA pueda escribir." };
  return result;
}

export async function selectGoogleCalendar(calendarId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const deps = await connectionDeps();
  if (!deps) return { ok: false, error: NOT_CONFIGURED };
  const result = await selectCalendar(deps, calendarId);
  if (!result.ok) return result;
  revalidatePath("/calendar");
  return { ok: true };
}

/** "Desconectar Google Calendar": revokes at Google (best effort) and deletes the connection. */
export async function disconnectGoogleCalendar(): Promise<{ ok: true } | { ok: false; error: string }> {
  const deps = await connectionDeps();
  if (!deps) return { ok: false, error: NOT_CONFIGURED };
  const result = await disconnect(deps);
  if (!result.ok) return result;
  revalidatePath("/calendar");
  return { ok: true };
}
