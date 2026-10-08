"use client";

// While TRAZA is open, asks the server now and then to deliver any reminder that is due (the planner
// runs on the server, deduplicated in the database). Rendered by the private layout only when Web
// Push is configured; renders nothing; never requests permission and never shows anything itself.
// Independent of the Canvas and Google triggers. Delivery with TRAZA closed comes with Prompt 23's
// trusted scheduler, which reuses the same server code.
import { useEffect } from "react";
import { NOTIFICATION_CHECK_PATH, PUSH_HEADER } from "@/lib/notifications/request";

const INITIAL_DELAY_MS = 20_000;
const INTERVAL_MS = 10 * 60 * 1000;
const MIN_GAP_MS = 4 * 60 * 1000;
const STORAGE_KEY = "traza.notification-check.last-request";

function sharedLast(): number {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function NotificationCheckTrigger() {
  useEffect(() => {
    let inFlight = false;
    let last = 0;

    async function check() {
      // Nothing to deliver to if this browser never allowed notifications (any device may still
      // receive them; one check per open TRAZA is enough, so only granted devices ask).
      if (inFlight || document.visibilityState !== "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
      const now = Date.now();
      if (now - Math.max(last, sharedLast()) < MIN_GAP_MS) return;
      last = now;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(now));
      } catch {
        // Per-tab suppression still applies.
      }
      inFlight = true;
      try {
        await fetch(NOTIFICATION_CHECK_PATH, { method: "POST", headers: { [PUSH_HEADER]: "1" }, credentials: "same-origin", cache: "no-store" });
      } catch {
        // Ignored: a later check tries again.
      } finally {
        inFlight = false;
      }
    }

    const initial = window.setTimeout(() => void check(), INITIAL_DELAY_MS);
    const interval = window.setInterval(() => void check(), INTERVAL_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
