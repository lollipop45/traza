export const LOGIN_PATH = "/login";
export const HOME_PATH = "/";

/**
 * Static, user-independent PWA files. They must load without a session (installing TRAZA or
 * registering the service worker can happen on the login page, and the offline page is shown when
 * there is no network) and they contain no user data. Icons are excluded by proxy.ts's matcher.
 */
export const PUBLIC_PWA_PATHS = new Set(["/manifest.webmanifest", "/sw.js", "/offline.html"]);

/**
 * Server-to-server endpoints. The proxy passes them through untouched (no session lookup, no
 * redirect, no cookie refresh): the scheduler authenticates with its own secret and the health check
 * returns no data. Exact paths only.
 */
export const SERVER_TO_SERVER_PATHS = new Set(["/api/internal/scheduler", "/api/health"]);

export function isServerToServerPath(pathname: string): boolean {
  return SERVER_TO_SERVER_PATHS.has(pathname);
}

/** Routes reachable without a session. Everything else is the private TRAZA app. */
export function isPublicPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || PUBLIC_PWA_PATHS.has(pathname);
}
