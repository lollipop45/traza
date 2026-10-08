import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { HOME_PATH, LOGIN_PATH, isPublicPath, isServerToServerPath } from "@/lib/auth/routes";
import type { Database } from "./database.types";
import { getSupabaseEnv } from "./env";

/**
 * Runs before every matched request: refreshes the Supabase session cookies and applies the
 * route policy (private app ⇄ /login). Pages re-verify the session server-side as well, so this
 * is the first line of defence, not the only one.
 */
export async function updateSession(request: NextRequest) {
  // The scheduler and the health check carry no user session: nothing to refresh or enforce here.
  if (isServerToServerPath(request.nextUrl.pathname)) return NextResponse.next();

  const { url, publishableKey } = getSupabaseEnv();
  let response = NextResponse.next({ request });

  // Create a new client per request; never share it between requests.
  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        // Cache-control headers that stop CDNs from caching responses carrying a session.
        Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  // Nothing may run between creating the client and getClaims(): it validates the JWT and
  // refreshes an expired session. Its claims, not getSession(), are the proof of identity.
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims?.sub);
  const { pathname } = request.nextUrl;

  // A signed-out API write (e.g. the Canvas auto-sync check) gets a plain 401, not a redirect to the
  // login page that fetch would follow. Handlers verify the session themselves as well.
  if (!isSignedIn && pathname.startsWith("/api/") && request.method !== "GET") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isSignedIn && !isPublicPath(pathname)) return redirectKeepingSession(request, response, LOGIN_PATH);
  if (isSignedIn && pathname === LOGIN_PATH) return redirectKeepingSession(request, response, HOME_PATH);

  // Return this exact response so the refreshed cookies reach the browser.
  return response;
}

/** A redirect that still carries any refreshed session cookies and cache headers. */
function redirectKeepingSession(request: NextRequest, from: NextResponse, pathname: string) {
  const target = request.nextUrl.clone();
  target.pathname = pathname;
  target.search = "";
  const redirect = NextResponse.redirect(target);
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  from.headers.forEach((value, key) => {
    if (key.toLowerCase() === "cache-control") redirect.headers.set(key, value);
  });
  return redirect;
}
