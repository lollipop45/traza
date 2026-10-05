// Canvas (Campus Virtual) configuration. SERVER-ONLY values: neither variable uses the
// NEXT_PUBLIC_ prefix, so Next.js never inlines them into browser bundles. The token is a personal
// credential with the same reach as the user's Canvas account: it is never logged, rendered,
// returned to the client or included in error messages.

export type CanvasConfig = {
  /** Normalised origin (+ optional path prefix), without trailing slash or /api/v1. */
  baseUrl: string;
  token: string;
};

export type CanvasConfigProblem = "missing" | "invalid-base-url" | "invalid-token";

export type CanvasConfigResult = { ok: true; config: CanvasConfig } | { ok: false; problem: CanvasConfigProblem };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Accepts e.g. "https://campus.example.edu", "https://campus.example.edu/" or
 * "https://campus.example.edu/api/v1" and returns "https://campus.example.edu".
 * HTTPS is required (plain HTTP only for loopback hosts, used by tests and local mocks); embedded
 * credentials, query strings and fragments are rejected. Returns null when invalid.
 */
export function normalizeCanvasBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) return null;

  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** Canvas tokens are opaque ("1234~abc…"). Reject blanks and anything that could break the header. */
export function isPlausibleCanvasToken(token: string): boolean {
  return token.length >= 10 && token.length <= 512 && /^[\x21-\x7e]+$/.test(token);
}

/** Reads and validates the configuration. `env` is injectable for tests; never logged. */
export function readCanvasConfig(env: Record<string, string | undefined> = process.env): CanvasConfigResult {
  const rawBaseUrl = env.CANVAS_BASE_URL?.trim();
  const token = env.CANVAS_ACCESS_TOKEN?.trim();
  if (!rawBaseUrl || !token) return { ok: false, problem: "missing" };

  const baseUrl = normalizeCanvasBaseUrl(rawBaseUrl);
  if (!baseUrl) return { ok: false, problem: "invalid-base-url" };
  if (!isPlausibleCanvasToken(token)) return { ok: false, problem: "invalid-token" };
  return { ok: true, config: { baseUrl, token } };
}
