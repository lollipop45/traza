// Provider-neutral contract for TRAZA's language-model calls. Application code (lib/assistant)
// depends only on this and on lib/ai/provider.ts, never on a concrete provider. The active
// implementation is lib/ai/groq.ts (lib/ai/gemini.ts is kept, inactive). A model is only ever
// asked for TEXT shaped by a JSON schema: it has no tools, no database access and no credentials.

/** A JSON-schema subset every structured-output provider understands (OpenAPI style). */
export type ResponseSchema =
  | { type: "object"; properties: Record<string, ResponseSchema>; required?: string[]; nullable?: boolean; description?: string }
  | { type: "array"; items: ResponseSchema; maxItems?: number; nullable?: boolean; description?: string }
  | { type: "string"; enum?: string[]; nullable?: boolean; description?: string }
  | { type: "boolean"; nullable?: boolean; description?: string };

/** The providers TRAZA can talk to. Only the one chosen in lib/ai/provider.ts is ever called. */
export type AiProviderName = "groq" | "gemini";

/** Server-only credentials for one provider call path. Never logged, rendered or stored. */
export type ProviderCredentials = { apiKey: string; model: string };

export type AiTurn = { role: "user" | "model"; text: string };

export type AiRequest = {
  /** Application instructions (and the user's data, clearly delimited as data). */
  system: string;
  /** The conversation, oldest first, ending with the user's new message. */
  turns: AiTurn[];
  /** The JSON shape the answer must have. */
  schema: ResponseSchema;
};

/** Why a call failed. Never carries provider messages, bodies, URLs or keys. */
export type AiFailureKind =
  /** No API key configured on the server. */
  | "not-configured"
  /** Network failure or 5xx. */
  | "unavailable"
  /** 429 / quota. */
  | "rate-limited"
  | "timeout"
  /** The provider refused the key or the request (401/403/400). */
  | "rejected"
  /** No usable text (blocked, empty, truncated, unexpected shape). */
  | "invalid-response";

/**
 * Where a provider call stopped, for DEVELOPMENT diagnostics only. A fixed vocabulary plus safe
 * numbers: never a key, header, prompt, the user's data or any part of the provider's response body.
 */
export type ProviderStage =
  | "request_failed"
  | "timeout"
  | "http_408"
  | "http_400"
  | "http_401"
  | "http_403"
  | "http_429"
  | "provider_5xx"
  | "empty_candidates"
  | "empty_choices"
  | "safety_block"
  | "max_tokens"
  | "empty_text"
  | "unexpected_response";

export type AiDiagnostic = {
  stage: ProviderStage | null;
  /** HTTP status of the provider response, if any (of the last attempt). */
  status?: number;
  /** HTTP attempts made (1 = no retry). */
  attempts?: number;
  /** Wall-clock milliseconds of the whole call, retries and waits included. */
  elapsedMs?: number;
  /** The provider's finish reason, upper-cased (an enum such as STOP, LENGTH, MAX_TOKENS, SAFETY). */
  finishReason?: string;
  /** Candidates (Gemini) or choices (OpenAI-compatible APIs) returned. */
  candidates?: number;
  /** Token usage reported by the provider (counts only). */
  tokens?: { prompt?: number; thoughts?: number; output?: number };
};

export type AiResult = { ok: true; text: string; diagnostic?: AiDiagnostic } | { ok: false; kind: AiFailureKind; diagnostic?: AiDiagnostic };

export interface AiProvider {
  /** Returns the model's JSON text (unvalidated: callers must validate it). Never throws. */
  generate(request: AiRequest): Promise<AiResult>;
}
