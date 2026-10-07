import type { AiProviderName, ProviderCredentials } from "./types";

// AI provider configuration. SERVER-ONLY values (no NEXT_PUBLIC_ prefix, so Next.js never inlines
// them into browser bundles). The key is never logged, rendered, stored or returned to the client.
//
// Active provider: Groq (OpenAI-compatible chat completions).
//   GROQ_API_KEY   Groq API key (required to enable the assistant)
//   GROQ_MODEL     optional model name; defaults to DEFAULT_GROQ_MODEL
//
// GEMINI_* variables are no longer read: the Gemini adapter is inactive.

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";

export type AiConfig = ProviderCredentials & { provider: AiProviderName };

const KEY = /^[\x21-\x7e]{20,200}$/;
/** "openai/gpt-oss-20b", "llama-3.3-70b-versatile": lower-case segments, at most one "/". */
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/;

export function isSafeModelName(model: string): boolean {
  return MODEL.test(model) && !model.includes("..");
}

/** The configuration, or null when the assistant is not configured. `env` is injectable for tests. */
export function readAiConfig(env: Record<string, string | undefined> = process.env): AiConfig | null {
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey || !KEY.test(apiKey)) return null;
  const rawModel = env.GROQ_MODEL?.trim();
  const model = rawModel && isSafeModelName(rawModel) ? rawModel : DEFAULT_GROQ_MODEL;
  return { provider: "groq", apiKey, model };
}
