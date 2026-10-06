import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_PATH } from "@/lib/auth/routes";
import { getSessionUser } from "@/lib/auth/session";
import { callbackRedirectSearch, completeAuthorization, type CallbackOutcome } from "@/lib/google-calendar/connection";
import { OAUTH_COOKIE_NAME } from "@/lib/google-calendar/cookie";
import { GOOGLE_CALLBACK_PATH, readGoogleCalendarConfig } from "@/lib/google-calendar/env";
import { createConnectionStore } from "@/lib/google-calendar/store";

// Google's OAuth redirect lands here (server-side only). It validates the encrypted state cookie
// against `state` (CSRF), checks that the same TRAZA user started the flow, exchanges the code with
// the client secret + PKCE verifier, stores the tokens encrypted, and redirects to /calendar with
// a result code. The redirect URL never carries a token or the code; nothing is logged.
//
// Development only: the redirect also carries `google_error=<stage>` from a fixed list (see
// CALLBACK_STAGES), naming where a failure happened. Production keeps the generic codes only.

export const dynamic = "force-dynamic";

const diagnostics = () => process.env.NODE_ENV !== "production";

function clearStateCookie(response: NextResponse) {
  // The pending authorization is single-use: cleared whatever the outcome.
  response.cookies.set(OAUTH_COOKIE_NAME, "", { path: GOOGLE_CALLBACK_PATH, maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/** Back to TRAZA, on the configured callback's origin when known (no trust in the Host header). */
function backToCalendar(origin: string, outcome: CallbackOutcome) {
  const target = new URL("/calendar", origin);
  target.search = callbackRedirectSearch(outcome, diagnostics()).toString();
  return clearStateCookie(NextResponse.redirect(target, 303));
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    const login = new URL(LOGIN_PATH, request.nextUrl.origin);
    if (diagnostics()) login.searchParams.set("google_error", "session_missing");
    return clearStateCookie(NextResponse.redirect(login, 303));
  }

  const configResult = readGoogleCalendarConfig();
  if (!configResult.ok) return backToCalendar(request.nextUrl.origin, { code: "no-configurado", stage: null });
  const origin = new URL(configResult.config.redirectUri).origin;

  try {
    const params = request.nextUrl.searchParams;
    const outcome = await completeAuthorization(
      { config: configResult.config, store: createConnectionStore(user.id), fetch: (input, init) => fetch(input, init), now: Date.now },
      {
        sealedState: (await cookies()).get(OAUTH_COOKIE_NAME)?.value,
        state: params.get("state"),
        code: params.get("code"),
        error: params.get("error"),
        sessionUserId: user.id,
      },
    );
    return backToCalendar(origin, outcome);
  } catch {
    // Discarded, not logged: an exception here could carry request or response details.
    return backToCalendar(origin, { code: "error", stage: "unexpected" });
  }
}
