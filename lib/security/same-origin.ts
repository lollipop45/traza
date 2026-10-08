// Same-origin POST check (CSRF) for TRAZA's background sync endpoints. Pure; tested without Next.js.
//
// Three independent signals, all required:
//   1. a custom header (`headerName: 1`): a cross-site page cannot send it without a CORS preflight,
//      which these endpoints never grant;
//   2. the browser's Sec-Fetch-Site, when sent, is "same-origin";
//   3. Origin is present and names this host (the Host header, or the first X-Forwarded-Host behind
//      a proxy, as Next.js does for Server Actions).

export function isSameOriginRequest(headers: Headers, headerName: string): boolean {
  if (headers.get(headerName) !== "1") return false;
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
