import "server-only";
import { readAiConfig } from "./env";
import { createGroqProvider } from "./groq";
import type { AiProvider } from "./types";

/** The configured provider (Groq), or null when GROQ_API_KEY is not set. Server-only. */
export function getAiProvider(): AiProvider | null {
  const config = readAiConfig();
  return config ? createGroqProvider(config) : null;
}

export function isAiConfigured(): boolean {
  return readAiConfig() !== null;
}

/** Safe labels for development diagnostics (never the key). */
export function aiDiagnosticLabels(): { provider: string | null; model: string | null } {
  const config = readAiConfig();
  return { provider: config?.provider ?? null, model: config?.model ?? null };
}
