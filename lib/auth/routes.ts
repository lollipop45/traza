export const LOGIN_PATH = "/login";
export const HOME_PATH = "/";

/** Routes reachable without a session. Everything else is the private TRAZA app. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === LOGIN_PATH ||
    // Temporary dev diagnostics; the page itself returns 404 in production.
    pathname.startsWith("/dev/")
  );
}
