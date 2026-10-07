"use client";

// Asks the server, now and then, whether the signed-in user's Canvas sync is due. Rendered only by
// the private app layout (never on /login), only when Canvas is configured, and renders nothing.
// It never blocks rendering, waits for nothing and shows nothing; the server decides everything
// (session, cooldown, lease) and answers with an outcome enum. When tasks changed, the current
// page is refreshed so they appear. No ids or data are ever sent.
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AUTO_SYNC_HEADER, AUTO_SYNC_PATH } from "@/lib/canvas/auto-sync-request";
import { AUTO_SYNC_HIDDEN_THRESHOLD_MS, AUTO_SYNC_INITIAL_DELAY_MS, AUTO_SYNC_INTERVAL_MS, AUTO_SYNC_MIN_GAP_MS } from "@/lib/canvas/sync-policy";

export function CanvasAutoSyncTrigger() {
  const router = useRouter();

  useEffect(() => {
    let lastRequest = 0;
    let inFlight = false;
    let hiddenSince: number | null = null;

    async function check() {
      if (inFlight || document.visibilityState !== "visible") return;
      if (lastRequest && Date.now() - lastRequest < AUTO_SYNC_MIN_GAP_MS) return;
      lastRequest = Date.now();
      inFlight = true;
      try {
        const response = await fetch(AUTO_SYNC_PATH, {
          method: "POST",
          headers: { [AUTO_SYNC_HEADER]: "1" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (typeof body === "object" && body !== null && (body as { changed?: unknown }).changed === true) router.refresh();
      } catch {
        // Never surfaces: the app keeps working and the next check retries later.
      } finally {
        inFlight = false;
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenSince = Date.now();
        return;
      }
      const wasHidden = hiddenSince !== null && Date.now() - hiddenSince >= AUTO_SYNC_HIDDEN_THRESHOLD_MS;
      hiddenSince = null;
      if (wasHidden) void check();
    }

    const initial = window.setTimeout(() => void check(), AUTO_SYNC_INITIAL_DELAY_MS);
    const interval = window.setInterval(() => void check(), AUTO_SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
