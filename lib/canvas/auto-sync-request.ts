import type { LeasedSyncResult, SyncOutcome } from "./auto-sync";

// The browser ↔ server contract of the automatic Canvas sync trigger. Pure (shared by the route
// handler and the client trigger; tested without Next.js).
//
// The browser only ever says "check whether my Canvas sync is due": no body is read, so no user,
// course, project or assignment id can be supplied. The answer is an enum and a boolean.

export const AUTO_SYNC_PATH = "/api/integrations/canvas/auto-sync";

/**
 * A custom header: a cross-site page cannot send it without a CORS preflight, which this endpoint
 * never grants. One of three independent same-origin checks (with Origin and Sec-Fetch-Site).
 */
export const AUTO_SYNC_HEADER = "x-traza-auto-sync";

/**
 * Same-origin POST check (CSRF): the custom header is present, the browser's Sec-Fetch-Site (when
 * sent) is "same-origin", and Origin is present and names this host (the Host header, or the first
 * X-Forwarded-Host behind a proxy, as Next.js does for Server Actions).
 */
export function isSameOriginRequest(headers: Headers): boolean {
  if (headers.get(AUTO_SYNC_HEADER) !== "1") return false;
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;

  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [headers.get("x-forwarded-host")?.split(",")[0], headers.get("host")]
    .map((host) => host?.trim().toLowerCase())
    .filter((host): host is string => Boolean(host));
  return hosts.includes(originHost);
}

/** What the browser receives: never counts, ids, names or error details. */
export type AutoSyncResponse = { outcome: SyncOutcome; changed: boolean };

export function autoSyncResponse(result: LeasedSyncResult): AutoSyncResponse {
  return { outcome: result.outcome, changed: result.imported + result.updated > 0 };
}
