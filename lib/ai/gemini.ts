import { defaultRuntime, postOnce, withRetries, type FetchLike, type RetryRuntime } from "./retry";
import type { AiDiagnostic, AiProvider, AiRequest, AiResult, ProviderCredentials, ResponseSchema } from "./types";

// INACTIVE: TRAZA's active provider is Groq (lib/ai/groq.ts, selected in lib/ai/provider.ts).
// Nothing in the application imports this module; it is kept, isolated and tested with fake fetch
// only, so a provider switch remains a one-line change.
//
// Google Gemini (Generative Language API, REST generateContent) with structured JSON output.
// The key travels only in the x-goog-api-key header (never in the URL), redirects are refused,
// and failures are categories only: provider messages and bodies are discarded, never shown or
// logged. No tools / function calling are declared: the model can only return text. Retries and
// HTTP failure mapping are shared with every adapter (lib/ai/retry.ts).

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini 2.5 models "think" before answering, and thinking tokens COUNT AGAINST maxOutputTokens.
 * With a small limit and dynamic thinking over a large context, the model can spend the whole
 * budget thinking and return no answer (finishReason MAX_TOKENS, empty or truncated JSON). So the
 * thinking budget is fixed and the total limit leaves ample room for the JSON answer.
 */
export const THINKING_BUDGET = 1024;
export const MAX_OUTPUT_TOKENS = 8192;

/** Models that accept thinkingConfig.thinkingBudget (a non-thinking model would reject it). */
export function supportsThinkingBudget(model: string): boolean {
  return /^gemini-2\.5-/.test(model);
}

/** Gemini's schema dialect: OpenAPI subset with upper-case type names. */
export function toGeminiSchema(schema: ResponseSchema): Record<string, unknown> {
  const base: Record<string, unknown> = { type: schema.type.toUpperCase() };
  if (schema.nullable) base.nullable = true;
  if (schema.description) base.description = schema.description;
  switch (schema.type) {
    case "object":
      base.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
      if (schema.required) base.required = schema.required;
      base.propertyOrdering = Object.keys(schema.properties);
      break;
    case "array":
      base.items = toGeminiSchema(schema.items);
      if (schema.maxItems !== undefined) base.maxItems = schema.maxItems;
      break;
    case "string":
      if (schema.enum) {
        base.format = "enum";
        base.enum = schema.enum;
      }
      break;
  }
  return base;
}

/** The request body (exported for tests; contains the prompt, so never logged). */
export function requestBody(model: string, request: AiRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: contents(request),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(request.schema),
      temperature: 0.2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(supportsThinkingBudget(model) ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET } } : {}),
    },
  };
}

/** Consecutive turns of the same role are merged (Gemini expects alternating roles). */
function contents(request: AiRequest) {
  const merged: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const turn of request.turns) {
    const last = merged.at(-1);
    if (last && last.role === turn.role) last.parts[0].text += `\n\n${turn.text}`;
    else merged.push({ role: turn.role, parts: [{ text: turn.text }] });
  }
  return merged;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Finish reasons meaning the answer was withheld or cut for policy reasons. */
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

/** The answer text: the non-"thought" text parts of the first candidate. */
export function extractText(body: unknown): string | null {
  const candidates = record(body)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const parts = record(record(candidates[0])?.content)?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((part): part is { text: string } => typeof part === "object" && part !== null && typeof part.text === "string" && part.thought !== true)
    .map((part) => part.text)
    .join("");
  return text.trim() ? text : null;
}

/**
 * Reads a 200 response: the answer text, or which safe stage failed. Only enums and counts are
 * kept for diagnostics (finish reason, candidate count, token usage), never content.
 */
export function readResponse(body: unknown): AiResult {
  const root = record(body);
  if (!root) return { ok: false, kind: "invalid-response", diagnostic: { stage: "unexpected_response" } };
  const usage = record(root.usageMetadata);
  const tokens = usage ? { prompt: count(usage.promptTokenCount), thoughts: count(usage.thoughtsTokenCount), output: count(usage.candidatesTokenCount) } : undefined;
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const blockReason = record(root.promptFeedback)?.blockReason;
  const base = { candidates: candidates.length, ...(tokens ? { tokens } : {}) };

  if (candidates.length === 0) {
    return { ok: false, kind: "invalid-response", diagnostic: { stage: typeof blockReason === "string" ? "safety_block" : "empty_candidates", ...base } };
  }
  const rawReason = record(candidates[0])?.finishReason;
  const finishReason = typeof rawReason === "string" && /^[A-Z_]{1,40}$/.test(rawReason) ? rawReason : undefined;
  const diagnostic: AiDiagnostic = { stage: null, ...base, ...(finishReason ? { finishReason } : {}) };

  if (finishReason && BLOCKED.has(finishReason)) return { ok: false, kind: "invalid-response", diagnostic: { ...diagnostic, stage: "safety_block" } };
  // Cut off: any text is an incomplete JSON document, so it is not even parsed.
  if (finishReason === "MAX_TOKENS") return { ok: false, kind: "invalid-response", diagnostic: { ...diagnostic, stage: "max_tokens" } };
  const text = extractText(root);
  if (!text) return { ok: false, kind: "invalid-response", diagnostic: { ...diagnostic, stage: "empty_text" } };
  return { ok: true, text, diagnostic };
}

export function createGeminiProvider(
  config: ProviderCredentials,
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  runtime: RetryRuntime = defaultRuntime,
): AiProvider {
  return {
    async generate(request: AiRequest): Promise<AiResult> {
      const url = `${ENDPOINT}/${encodeURIComponent(config.model)}:generateContent`;
      const body = JSON.stringify(requestBody(config.model, request));
      return withRetries(runtime, (timeoutMs) => postOnce(fetchFn, url, { "x-goog-api-key": config.apiKey }, body, timeoutMs, readResponse));
    },
  };
}
