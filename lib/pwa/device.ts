// What this browser / device can do with TRAZA as an installed app. Pure: the inputs are read from
// the browser by the client components (components/pwa) and passed in, so every rule is tested
// without a browser. Nothing here is sent to the server.

export type DisplayEnvironment = {
  /** matchMedia("(display-mode: standalone)") — Chromium, Firefox, recent Safari. */
  standaloneMedia: boolean;
  /** navigator.standalone — Safari on iPhone/iPad (Home Screen apps). Undefined elsewhere. */
  navigatorStandalone: boolean | undefined;
  userAgent: string;
  /** navigator.maxTouchPoints (iPadOS reports itself as a Mac). */
  maxTouchPoints: number;
};

/** Running as an installed app (Home Screen / desktop window), whichever signal the browser offers. */
export function isStandalone(env: DisplayEnvironment): boolean {
  return env.standaloneMedia || env.navigatorStandalone === true;
}

/** iPhone, iPod or iPad (including iPadOS's desktop-class user agent). */
export function isIOS(env: Pick<DisplayEnvironment, "userAgent" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

export type InstallState =
  /** Already running installed: no install controls at all. */
  | "installed"
  /** The browser offered beforeinstallprompt: a button can open its install dialog. */
  | "prompt"
  /** iPhone/iPad in the browser: there is no install API, only Share → Add to Home Screen. */
  | "ios"
  /** Nothing to offer (unsupported browser, or already installed elsewhere). */
  | "unavailable";

export function installState(env: DisplayEnvironment, hasInstallPrompt: boolean): InstallState {
  if (isStandalone(env)) return "installed";
  if (hasInstallPrompt) return "prompt";
  if (isIOS(env)) return "ios";
  return "unavailable";
}

/** A dismissed install hint stays hidden on this device for this long. */
export const INSTALL_HINT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
export const INSTALL_HINT_STORAGE_KEY = "traza.install-hint.dismissed-at";

/** The small, dismissible install hint: only when something can be done and it was not dismissed recently. */
export function shouldShowInstallHint(state: InstallState, dismissedAt: number | null, now: number): boolean {
  if (state !== "prompt" && state !== "ios") return false;
  return dismissedAt === null || !Number.isFinite(dismissedAt) || now - dismissedAt >= INSTALL_HINT_SNOOZE_MS || dismissedAt > now;
}

export type PushCapabilities = {
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
};

export type PushSupport =
  | "supported"
  /** iPhone/iPad: Web Push only works in an installed Home Screen app. */
  | "needs-install"
  | "unsupported";

export function pushSupport(env: DisplayEnvironment, capabilities: PushCapabilities): PushSupport {
  if (isIOS(env) && !isStandalone(env)) return "needs-install";
  return capabilities.serviceWorker && capabilities.pushManager && capabilities.notification ? "supported" : "unsupported";
}

/** Notification state of THIS device, as shown in Ajustes. */
export type DeviceNotificationState = "unsupported" | "needs-install" | "no-permission" | "blocked" | "active" | "inactive";

export function deviceNotificationState(support: PushSupport, permission: NotificationPermission | null, subscribed: boolean): DeviceNotificationState {
  if (support === "unsupported") return "unsupported";
  if (support === "needs-install") return "needs-install";
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "no-permission";
  return subscribed ? "active" : "inactive";
}

export const DEVICE_NOTIFICATION_LABELS: Record<DeviceNotificationState, string> = {
  unsupported: "No disponibles en este dispositivo",
  "needs-install": "Instala TRAZA primero",
  "no-permission": "Sin permiso",
  blocked: "Bloqueadas",
  active: "Activas",
  inactive: "Desactivadas en este dispositivo",
};

/**
 * VAPID public key (base64url) → the Uint8Array PushManager.subscribe() expects. Null when the
 * value is not a 65-byte uncompressed P-256 point.
 */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(base64url)) return null;
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  if (binary.length !== 65 || binary.charCodeAt(0) !== 0x04) return null;
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
