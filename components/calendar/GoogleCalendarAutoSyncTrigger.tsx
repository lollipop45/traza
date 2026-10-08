"use client";

// Asks the server, now and then, whether the signed-in user's Google Calendar sync is due. Rendered
// only by the private app layout (never on /login), only when Google is configured on the server,
// and renders nothing. Independent of the Canvas trigger: each runs on its own timers, neither waits
// for the other, and a failure of one never affects the other. It shows nothing (no toast); when
// Google events changed in TRAZA, the current page is refreshed. No ids, tokens or data are sent.
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { GOOGLE_AUTO_SYNC_HEADER, GOOGLE_AUTO_SYNC_PATH, GOOGLE_AUTO_SYNC_STORAGE_KEY } from "@/lib/google-calendar/auto-sync-request";
import {
  GOOGLE_AUTO_SYNC_HIDDEN_THRESHOLD_MS,
  GOOGLE_AUTO_SYNC_INITIAL_DELAY_MS,
  GOOGLE_AUTO_SYNC_INTERVAL_MS,
  GOOGLE_AUTO_SYNC_MIN_GAP_MS,
} from "@/lib/google-calendar/sync-policy";

/** Last request time shared by all tabs; storage may be unavailable (private mode): then 0. */
function sharedLastRequest(): number {
  try {
    const value = Number(window.localStorage.getItem(GOOGLE_AUTO_SYNC_STORAGE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function rememberRequest(at: number) {
  try {
    window.localStorage.setItem(GOOGLE_AUTO_SYNC_STORAGE_KEY, String(at));
  } catch {
    // Per-tab suppression still applies; the server-side cooldown stays authoritative.
  }
}

export function GoogleCalendarAutoSyncTrigger() {
  const router = useRouter();

  useEffect(() => {
    let lastRequest = 0;
    let inFlight = false;
    let hiddenSince: number | null = null;

    async function check() {
      if (inFlight || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - Math.max(lastRequest, sharedLastRequest()) < GOOGLE_AUTO_SYNC_MIN_GAP_MS) return;
      lastRequest = now;
      rememberRequest(now);
      inFlight = true;
      try {
        const response = await fetch(GOOGLE_AUTO_SYNC_PATH, {
          method: "POST",
          headers: { [GOOGLE_AUTO_SYNC_HEADER]: "1" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (typeof body === "object" && body !== null && (body as { changed?: unknown }).changed === true) router.refresh();
      } catch {
        // Never surfaces: the app keeps working and a later check tries again.
      } finally {
        inFlight = false;
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenSince = Date.now();
        return;
      }
      const wasHidden = hiddenSince !== null && Date.now() - hiddenSince >= GOOGLE_AUTO_SYNC_HIDDEN_THRESHOLD_MS;
      hiddenSince = null;
      if (wasHidden) void check();
    }

    const initial = window.setTimeout(() => void check(), GOOGLE_AUTO_SYNC_INITIAL_DELAY_MS);
    const interval = window.setInterval(() => void check(), GOOGLE_AUTO_SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
