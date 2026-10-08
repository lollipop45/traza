import type { FetchLike } from "./types";

// Bounded retries for every Google request of a sync run (Calendar API and the OAuth token
// endpoint), as a decorator around fetch: the callers (events.ts, client.ts, oauth.ts) keep their
// own classification and never see the intermediate failures.
//
//   Retried: network errors, timeouts, 408, 429, 500, 502, 503, 504, and a 403 whose reason is a
//            rate limit (Google reports some rate limits as 403 rateLimitExceeded /
//            userRateLimitExceeded). Every Google request TRAZA makes is safe to repeat: listing,
//            PUT/DELETE of a known id, and POST with TRAZA's deterministic id (a repeat is a 409,
//            which the sync already turns into an update).
//   Never:   400, 401 (the sync's single token refresh handles it), other 403s, 404/409/410, and
//            successful responses (malformed bodies are rejected by the callers).
//   Policy:  at most 3 attempts; ~0.5 s then ~1 s (±25 %); Retry-After honoured up to 10 s (a longer
//            one is not waited for); nothing starts or waits past the run's deadline.
// A rate-limit 403 is handed back as a body-less 429 so the callers classify it as a rate limit.
// Failure bodies are read only to find that reason (bounded, never kept or logged).

export const GOOGLE_MAX_ATTEMPTS = 3;
export const GOOGLE_RETRY_BASE_MS = 500;
export const GOOGLE_RETRY_JITTER = 0.25;
export const GOOGLE_MAX_RETRY_AFTER_MS = 10_000;

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const MAX_ERROR_BODY = 8_192;

export type RetryOptions = {
  /** Absolute time (per `now`) after which no request is started or retried. */
  deadline?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry-After as delta-seconds or an HTTP date, in ms from `now`; null when absent or unreadable. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d{1,6}$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Whether a 403 is Google's rate limit (by its error reason only). Consumes the body. */
export async function isRateLimit403(response: Response): Promise<boolean> {
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY);
    const error = (JSON.parse(text) as { error?: { errors?: { reason?: unknown }[]; status?: unknown } }).error;
    const reasons = Array.isArray(error?.errors) ? error.errors.map((entry) => entry?.reason) : [];
    return reasons.some((reason) => typeof reason === "string" && RATE_LIMIT_REASONS.has(reason));
  } catch {
    return false;
  }
}

export function withGoogleRetries(fetchFn: FetchLike, options: RetryOptions = {}): FetchLike {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const { deadline } = options;

  return async (input, init) => {
    let lastError: unknown = null;
    for (let attempt = 1; ; attempt++) {
      if (deadline !== undefined && now() >= deadline) {
        throw lastError ?? new DOMException("The sync deadline was reached", "TimeoutError");
      }
      let response: Response | null = null;
      try {
        response = await fetchFn(input, init);
        lastError = null;
      } catch (error) {
        // Discarded by the callers (they only keep "unavailable"); kept here to rethrow as-is.
        lastError = error;
      }

      let rateLimited = false;
      if (response?.status === 403) {
        rateLimited = await isRateLimit403(response);
        // The body was consumed: hand back a body-less response the callers can classify.
        response = rateLimited ? new Response(null, { status: 429, headers: response.headers }) : new Response(null, { status: 403 });
      }
      const transient = response === null || RETRYABLE.has(response.status) || rateLimited;
      if (!transient || attempt >= GOOGLE_MAX_ATTEMPTS) {
        if (response) return response;
        throw lastError;
      }

      let wait = Math.round(GOOGLE_RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + (Math.min(Math.max(random(), 0), 1) * 2 - 1) * GOOGLE_RETRY_JITTER));
      const retryAfter = response ? parseRetryAfter(response.headers.get("retry-after"), now()) : null;
      if (retryAfter !== null) {
        if (retryAfter > GOOGLE_MAX_RETRY_AFTER_MS) return response!;
        wait = Math.max(wait, retryAfter);
      }
      if (deadline !== undefined && now() + wait >= deadline) {
        if (response) return response;
        throw lastError;
      }
      await response?.body?.cancel().catch(() => undefined);
      await sleep(wait);
    }
  };
}
