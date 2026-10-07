import { defaultRuntime, postOnce, withRetries, type FetchLike, type RetryRuntime } from "./retry";
import type { AiDiagnostic, AiProvider, AiRequest, AiResult, ProviderCredentials, ResponseSchema } from "./types";

// Groq (OpenAI-compatible REST chat completions) with STRICT structured output: the model is
// constrained to TRAZA's JSON schema at the token level. The application still validates every
// answer itself (lib/assistant/response.ts): strict output is a convenience, not a trust boundary.
//
// The key travels only in the Authorization header, redirects are refused, and failures are
// categories only: provider messages and bodies are discarded, never shown or logged. No tools,
// browser search or code execution are declared: the model can only return text. Reasoning is
// low-effort and never returned (and never read if it were). Retries: lib/ai/retry.ts.

export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const SCHEMA_NAME = "traza_assistant_response";
/** Reasoning tokens count against this limit too; low effort leaves ample room for the JSON. */
export const MAX_COMPLETION_TOKENS = 8192;

/**
 * Hidden, low-effort reasoning, per model family. Groq rejects `reasoning_format` on the GPT-OSS
 * models: there, reasoning is hidden with `include_reasoning: false` (the two parameters are
 * mutually exclusive). Models that support `reasoning_format` get "hidden". Others get neither.
 */
export function reasoningOptions(model: string): Record<string, unknown> {
  if (/^openai\/gpt-oss-/.test(model)) return { reasoning_effort: "low", include_reasoning: false };
  if (/^qwen\/qwen3/.test(model)) return { reasoning_format: "hidden" };
  return {};
}

/**
 * TRAZA's schema in strict-mode JSON Schema: every property is listed in `required`, every object
 * is closed (`additionalProperties: false`), and a property that was optional or nullable becomes
 * a `["<type>", "null"]` union (an enum also admits null). `maxItems` is not sent (not supported
 * in strict mode); the application caps the number of proposals itself.
 */
export function toStrictSchema(schema: ResponseSchema, nullable = schema.nullable === true): Record<string, unknown> {
  const out: Record<string, unknown> = { type: nullable ? [schema.type, "null"] : schema.type };
  if (schema.description) out.description = schema.description;
  switch (schema.type) {
    case "object": {
      const required = new Set(schema.required ?? []);
      out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toStrictSchema(value, value.nullable === true || !required.has(key))]));
      out.required = Object.keys(schema.properties);
      out.additionalProperties = false;
      break;
    }
    case "array":
      out.items = toStrictSchema(schema.items);
      break;
    case "string":
      if (schema.enum) out.enum = nullable ? [...schema.enum, null] : [...schema.enum];
      break;
  }
  return out;
}

/** The request body (exported for tests; contains the prompt, so never logged). */
export function requestBody(model: string, request: AiRequest): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "system", content: request.system }, ...request.turns.map((turn) => ({ role: turn.role === "model" ? "assistant" : "user", content: turn.text }))],
    response_format: { type: "json_schema", json_schema: { name: SCHEMA_NAME, strict: true, schema: toStrictSchema(request.schema) } },
    ...reasoningOptions(model),
    temperature: 0.2,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    stream: false,
  };
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Reads a 200 response: `choices[0].message.content`, or which safe stage failed. Only enums and
 * counts are kept for diagnostics (finish reason, choice count, token usage), never content. Any
 * reasoning field the provider might add is ignored.
 */
export function readResponse(body: unknown): AiResult {
  const root = record(body);
  if (!root) return { ok: false, kind: "invalid-response", diagnostic: { stage: "unexpected_response" } };
  const usage = record(root.usage);
  const tokens = usage
    ? { prompt: count(usage.prompt_tokens), thoughts: count(record(usage.completion_tokens_details)?.reasoning_tokens), output: count(usage.completion_tokens) }
    : undefined;
  if (root.choices !== undefined && !Array.isArray(root.choices)) return { ok: false, kind: "invalid-response", diagnostic: { stage: "unexpected_response" } };
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const base = { candidates: choices.length, ...(tokens ? { tokens } : {}) };
  if (choices.length === 0) return { ok: false, kind: "invalid-response", diagnostic: { stage: "empty_choices", ...base } };

  const choice = record(choices[0]);
  const rawReason = choice?.finish_reason;
  const finishReason = typeof rawReason === "string" && /^[a-z_]{1,40}$/.test(rawReason) ? rawReason.toUpperCase() : undefined;
  const diagnostic: AiDiagnostic = { stage: null, ...base, ...(finishReason ? { finishReason } : {}) };
  const message = record(choice?.message);

  if (finishReason === "CONTENT_FILTER" || (typeof message?.refusal === "string" && message.refusal.length > 0)) {
    return { ok: false, kind: "invalid-response", diagnostic: { ...diagnostic, stage: "safety_block" } };
  }
  // Cut off: any text is an incomplete JSON document, so it is not even parsed.
  if (finishReason === "LENGTH") return { ok: false, kind: "invalid-response", diagnostic: { ...diagnostic, stage: "max_tokens" } };
  if (!message) return { ok: false, kind: "invalid-response", diagnostic: { ...diagnostic, stage: "unexpected_response" } };
  const content = message.content;
  if (typeof content !== "string" || !content.trim()) return { ok: false, kind: "invalid-response", diagnostic: { ...diagnostic, stage: "empty_text" } };
  return { ok: true, text: content, diagnostic };
}

export function createGroqProvider(
  config: ProviderCredentials,
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  runtime: RetryRuntime = defaultRuntime,
): AiProvider {
  return {
    async generate(request: AiRequest): Promise<AiResult> {
      const body = JSON.stringify(requestBody(config.model, request));
      return withRetries(runtime, (timeoutMs) => postOnce(fetchFn, GROQ_ENDPOINT, { Authorization: `Bearer ${config.apiKey}` }, body, timeoutMs, readResponse));
    },
  };
}
