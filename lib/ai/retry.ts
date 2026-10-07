import type { AiFailureKind, AiResult, ProviderStage } from "./types";

// Provider-neutral HTTP plumbing shared by the REST adapters: the bounded retry policy and the
// mapping of HTTP statuses to safe failure categories.
//
// Retries are for TRANSIENT failures only (408, 429, 500, 502, 503, 504, network errors and
// per-attempt timeouts). A generation request has no side effects, so repeating it is safe;
// retries happen inside the adapter, below the assistant turn, so they can never store a message
// or a proposal twice. Never retried: 400/401/403 (a retry cannot fix them), a 200 whose body is
// malformed, blocked, truncated or empty, and anything the assistant's validation rejects.
//
// Policy: 1 attempt + up to 3 retries, after ~1 s, ~2 s and ~4 s (±25 % jitter), each attempt
// limited to 20 s, and the whole call (attempts + waits) to 60 s: a retry that could not start
// with at least 5 s left is not attempted.

export const MAX_ATTEMPTS = 4;
export const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
export const RETRY_JITTER = 0.25;
export const ATTEMPT_TIMEOUT_MS = 20_000;
export const TOTAL_TIMEOUT_MS = 60_000;
const MIN_ATTEMPT_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Clock, waiting and randomness, injectable so tests run the retry policy instantly and deterministically. */
export type RetryRuntime = {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
};

export const defaultRuntime: RetryRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
};

/** Whether a failed attempt is worth repeating. */
export function isRetryable(result: AiResult): boolean {
  if (result.ok) return false;
  const stage = result.diagnostic?.stage;
  if (stage === "request_failed" || stage === "timeout") return true;
  // Only HTTP failures carry these statuses (a 200 with an unusable body never does).
  return result.diagnostic?.status !== undefined && RETRYABLE_STATUS.has(result.diagnostic.status);
}

/** The wait before retry number `retry` (1-based), with bounded jitter. `random` in [0, 1). */
export function retryDelay(retry: number, random: number): number {
  const base = RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length) - 1];
  return Math.round(base * (1 + (Math.min(Math.max(random, 0), 1) * 2 - 1) * RETRY_JITTER));
}

export function httpFailure(status: number): { kind: AiFailureKind; stage: ProviderStage } {
  if (status === 408) return { kind: "timeout", stage: "http_408" };
  if (status === 429) return { kind: "rate-limited", stage: "http_429" };
  if (status >= 500) return { kind: "unavailable", stage: "provider_5xx" };
  if (status === 400) return { kind: "rejected", stage: "http_400" };
  if (status === 401) return { kind: "rejected", stage: "http_401" };
  if (status === 403) return { kind: "rejected", stage: "http_403" };
  return { kind: "invalid-response", stage: "unexpected_response" };
}

/**
 * One POST attempt. Never throws. Failure bodies are never read (they could echo the request);
 * a 200 body is parsed as JSON and handed to `read`, which keeps only safe metadata.
 */
export async function postOnce(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  read: (parsed: unknown) => AiResult,
): Promise<AiResult> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Discarded (it may describe the request); only its category is kept.
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { ok: false, kind: timedOut ? "timeout" : "unavailable", diagnostic: { stage: timedOut ? "timeout" : "request_failed" } };
  }
  if (!response.ok) {
    const failure = httpFailure(response.status);
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, kind: failure.kind, diagnostic: { stage: failure.stage, status: response.status } };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, kind: "invalid-response", diagnostic: { stage: "unexpected_response", status: response.status } };
  }
  const result = read(parsed);
  if (result.diagnostic) result.diagnostic.status = response.status;
  return result;
}

/** Runs `attempt` under the retry policy; the result carries the attempt count and elapsed time. */
export async function withRetries(runtime: RetryRuntime, attempt: (timeoutMs: number) => Promise<AiResult>): Promise<AiResult> {
  const started = runtime.now();
  for (let n = 1; ; n++) {
    const remaining = TOTAL_TIMEOUT_MS - (runtime.now() - started);
    const result = await attempt(Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, remaining)));
    const done = (): AiResult => ({ ...result, diagnostic: { ...(result.diagnostic ?? { stage: null }), attempts: n, elapsedMs: runtime.now() - started } });
    if (result.ok || !isRetryable(result) || n >= MAX_ATTEMPTS) return done();

    const delay = retryDelay(n, runtime.random());
    // Keep the whole call bounded: only retry if a useful attempt still fits after the wait.
    if (runtime.now() - started + delay + MIN_ATTEMPT_MS > TOTAL_TIMEOUT_MS) return done();
    await runtime.sleep(delay);
  }
}
