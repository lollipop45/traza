import type { CanvasConfig } from "./env";
import { CanvasError, type CanvasErrorKind, type CanvasFailureDetail } from "./types";

// Small typed fetch client for the Canvas REST API. Used only on the server (lib/canvas/queries.ts
// is the server-only entry point). Guarantees:
//   - the token travels only in the Authorization header, only to the configured Canvas origin
//     (redirects are refused and pagination links to other origins are rejected);
//   - errors carry a category and status, never URLs, bodies or headers;
//   - a timeout on every request, and bounded retries for transient failures only (network errors,
//     timeouts, 429, 500, 502, 503, 504): at most 3 attempts, exponential backoff with jitter,
//     Retry-After honoured up to 10 s (a longer one is not waited for), and an optional deadline
//     shared by every request of a sync run. 401, 403, other statuses and malformed bodies are
//     never retried.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type CanvasClientOptions = {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Upper bound on followed pages, so a misbehaving Link header cannot loop forever. */
  maxPages?: number;
  /** Base backoff before the first retry (doubled for the next one). */
  retryDelayMs?: number;
  /** Absolute time (per `now`) after which no request is started or retried. */
  deadline?: number;
  /** Injectable for tests: waiting, randomness (jitter) and the clock. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_RETRY_DELAY_MS = 500;
export const CANVAS_MAX_ATTEMPTS = 3;
export const CANVAS_RETRY_JITTER = 0.25;
/** A Retry-After longer than this is not waited for: the run fails now and backs off instead. */
export const CANVAS_MAX_RETRY_AFTER_MS = 10_000;
/** Canvas caps per_page per installation (often 100); it silently lowers larger values. */
export const CANVAS_PAGE_SIZE = 100;

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Retry-After as delta-seconds or an HTTP date, in ms from `now`; null when absent or unreadable. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d{1,6}$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export type QueryParams = Record<string, string | number | readonly string[]>;

/** "https://campus.example.edu" + "users/self" → "https://campus.example.edu/api/v1/users/self". */
export function canvasApiUrl(baseUrl: string, path: string, params: QueryParams = {}): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/api/v1/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** The only place the token is used. */
export function canvasRequestHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    // String ids: Canvas ids can exceed what a JS number represents exactly.
    Accept: "application/json+canvas-string-ids",
  };
}

export function classifyStatus(status: number): CanvasErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status >= 300 && status < 400) return "redirected";
  if (status === 429 || status >= 500) return "unavailable";
  return "invalid-response";
}

/** Extracts the rel="next" URL from a Link header (RFC 8288), or null. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;(.*)/);
    if (!match) continue;
    const rel = match[2].match(/rel\s*=\s*"?([^";]+)"?/i);
    if (rel && rel[1].trim().toLowerCase().split(/\s+/).includes("next")) return match[1].trim();
  }
  return null;
}

/** A pagination link is only followed if it stays on the configured Canvas API. */
export function isSameCanvasApi(baseUrl: string, candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  const base = new URL(baseUrl);
  const apiPrefix = `${base.pathname.replace(/\/+$/, "")}/api/v1/`;
  return url.origin === base.origin && url.pathname.startsWith(apiPrefix) && !url.username && !url.password;
}

/** Canvas can prefix JSON with "while(1);" as an anti-hijacking measure. */
function parseJsonBody(body: string): unknown {
  return JSON.parse(body.replace(/^while\(1\);/, ""));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type CanvasClient = {
  getJson(path: string, params?: QueryParams): Promise<unknown>;
  getAllPages(path: string, params?: QueryParams): Promise<{ items: unknown[]; truncated: boolean }>;
};

export function createCanvasClient(config: CanvasConfig, options: CanvasClientOptions = {}): CanvasClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const deadline = options.deadline;
  const headers = canvasRequestHeaders(config.token);

  async function request(url: string): Promise<{ data: unknown; next: string | null }> {
    let response: Response | null = null;
    let detail: CanvasFailureDetail = "network";
    for (let attempt = 1; ; attempt++) {
      const left = deadline === undefined ? Infinity : deadline - now();
      if (left <= 0) throw new CanvasError("unavailable", response?.status ?? null, "timeout");
      try {
        response = await doFetch(url, {
          method: "GET",
          headers,
          // Never follow a redirect: it could carry the Authorization header elsewhere.
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, left))),
        });
      } catch (error) {
        // Network failure or timeout. The error itself is discarded: it may contain the URL.
        response = null;
        const name = error instanceof Error ? error.name : "";
        detail = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      }
      const transient = response === null || TRANSIENT_STATUSES.has(response.status);
      if (!transient || attempt >= CANVAS_MAX_ATTEMPTS) break;

      let wait = Math.round(retryDelayMs * 2 ** (attempt - 1) * (1 + (Math.min(Math.max(random(), 0), 1) * 2 - 1) * CANVAS_RETRY_JITTER));
      const retryAfter = response ? parseRetryAfter(response.headers.get("retry-after"), now()) : null;
      if (retryAfter !== null) {
        if (retryAfter > CANVAS_MAX_RETRY_AFTER_MS) break;
        wait = Math.max(wait, retryAfter);
      }
      if (deadline !== undefined && now() + wait >= deadline) break;
      await response?.body?.cancel().catch(() => undefined);
      await sleep(wait);
    }

    if (!response) throw new CanvasError("unavailable", null, detail);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CanvasError(classifyStatus(response.status), response.status);
    }

    let data: unknown;
    try {
      data = parseJsonBody(await response.text());
    } catch {
      throw new CanvasError("invalid-response", response.status);
    }
    return { data, next: parseNextLink(response.headers.get("link")) };
  }

  return {
    async getJson(path, params) {
      return (await request(canvasApiUrl(config.baseUrl, path, params))).data;
    },

    async getAllPages(path, params = {}) {
      const items: unknown[] = [];
      const seen = new Set<string>();
      let url: string | null = canvasApiUrl(config.baseUrl, path, { per_page: CANVAS_PAGE_SIZE, ...params });

      for (let page = 0; url; page++) {
        if (page >= maxPages) return { items, truncated: true };
        seen.add(url);
        const { data, next }: { data: unknown; next: string | null } = await request(url);
        if (!Array.isArray(data)) throw new CanvasError("invalid-response");
        items.push(...data);

        if (next && !isSameCanvasApi(config.baseUrl, next)) throw new CanvasError("invalid-response");
        // A repeated link would loop forever: treat it as the end.
        url = next && !seen.has(next) ? next : null;
      }
      return { items, truncated: false };
    },
  };
}
