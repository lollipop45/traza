"use client";

// Browser readings for lib/pwa/device.ts, as React hooks. They return null during server rendering
// and the first client render (so markup always hydrates identically), then the real values.
import { useSyncExternalStore } from "react";
import type { DisplayEnvironment, PushCapabilities } from "./device";
import { installPromptSnapshot, subscribeInstallPrompt } from "./install-prompt";

let cachedEnvironment: DisplayEnvironment | null = null;

function readEnvironment(): DisplayEnvironment {
  const next: DisplayEnvironment = {
    standaloneMedia: window.matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
  // A stable object while nothing changed (useSyncExternalStore compares snapshots by identity).
  if (
    !cachedEnvironment ||
    cachedEnvironment.standaloneMedia !== next.standaloneMedia ||
    cachedEnvironment.navigatorStandalone !== next.navigatorStandalone ||
    cachedEnvironment.userAgent !== next.userAgent ||
    cachedEnvironment.maxTouchPoints !== next.maxTouchPoints
  ) {
    cachedEnvironment = next;
  }
  return cachedEnvironment;
}

function subscribeEnvironment(onChange: () => void): () => void {
  const query = window.matchMedia("(display-mode: standalone)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useDisplayEnvironment(): DisplayEnvironment | null {
  return useSyncExternalStore(subscribeEnvironment, readEnvironment, () => null);
}

export function useInstallPrompt(): "installed" | "available" | "none" {
  return useSyncExternalStore(subscribeInstallPrompt, installPromptSnapshot, () => "none");
}

let cachedCapabilities: PushCapabilities | null = null;
const noop = () => () => undefined;

export function usePushCapabilities(): PushCapabilities | null {
  return useSyncExternalStore(
    noop,
    () =>
      (cachedCapabilities ??= {
        serviceWorker: "serviceWorker" in navigator,
        pushManager: "PushManager" in window,
        notification: "Notification" in window,
      }),
    () => null,
  );
}
