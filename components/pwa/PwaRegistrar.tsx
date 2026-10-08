"use client";

// Registers TRAZA's service worker (public/sw.js) once per page load, after the page has loaded so
// it never competes with rendering, and keeps Chromium's install prompt for later. Renders nothing.
// A failed registration is ignored (TRAZA works without it); nothing is logged. Updates follow the
// browser's normal cycle (the worker script is served no-cache), without forcing any reload.
import { useEffect } from "react";
import { markInstalled, setInstallPrompt, type BeforeInstallPromptEvent } from "@/lib/pwa/install-prompt";

export function PwaRegistrar() {
  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Keep it for the "Instalar TRAZA" control instead of the browser's own banner.
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => markInstalled();
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    const register = () => {
      if (!("serviceWorker" in navigator)) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
