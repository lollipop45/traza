"use client";

// Holds Chromium's deferred `beforeinstallprompt` event (no other browser fires it) so a restrained
// "Instalar TRAZA" control can open the browser's own install dialog later, on a user gesture.
// A tiny external store for useSyncExternalStore; nothing is persisted or sent anywhere.

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function setInstallPrompt(event: BeforeInstallPromptEvent | null) {
  deferred = event;
  emit();
}

export function markInstalled() {
  installed = true;
  deferred = null;
  emit();
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot for useSyncExternalStore: "installed" (appinstalled fired), "available", or "none". */
export function installPromptSnapshot(): "installed" | "available" | "none" {
  if (installed) return "installed";
  return deferred ? "available" : "none";
}

/** Opens the browser's install dialog (must run inside a user gesture). True if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  // The event can be used only once.
  setInstallPrompt(null);
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") markInstalled();
    return choice.outcome === "accepted";
  } catch {
    return false;
  }
}
