import { GOOGLE_CALLBACK_PATH } from "./env";
import { OAUTH_STATE_TTL_SECONDS } from "./oauth";

// The pending-authorization cookie: encrypted state + PKCE verifier + user id. httpOnly (no
// browser script can read it), scoped to the callback path, SameSite=Lax (sent on Google's
// top-level redirect back), Secure whenever the callback is https, and short-lived. It holds no
// Google token; it is deleted by the callback in every case.

export const OAUTH_COOKIE_NAME = "traza_google_oauth";

export function oauthCookieOptions(redirectUri: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: redirectUri.startsWith("https://"),
    path: GOOGLE_CALLBACK_PATH,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  };
}
