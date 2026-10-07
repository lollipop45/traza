import { isSafeModelName } from "@/lib/ai/env";
import type { TurnDiagnostic } from "./turn";

// DEVELOPMENT-ONLY diagnostics for the assistant's provider path. The line is built from a
// whitelist of fixed-vocabulary stages, enums and numbers: never the key, headers, prompt, the
// user's TRAZA data, the model's text or a provider response body.

const STAGE = /^[a-z0-9_]{1,40}$/;
const ENUM = /^[A-Z_]{1,40}$/;
const PROVIDER = /^[a-z]{1,20}$/;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : null);

/** "provider=groq stage=none status=200 attempts=1 elapsed=840ms finish=STOP candidates=1 tokens=prompt:9120,thoughts:120,output:300 model=openai/gpt-oss-20b" */
export function diagnosticLine(diagnostic: TurnDiagnostic | undefined, model: string | null, provider: string | null = null): string {
  const parts = provider && PROVIDER.test(provider) ? [`provider=${provider}`] : [];
  parts.push(`stage=${diagnostic?.stage && STAGE.test(diagnostic.stage) ? diagnostic.stage : "none"}`);
  if (num(diagnostic?.status)) parts.push(`status=${num(diagnostic?.status)}`);
  if (num(diagnostic?.attempts)) parts.push(`attempts=${num(diagnostic?.attempts)}`);
  if (num(diagnostic?.elapsedMs)) parts.push(`elapsed=${num(diagnostic?.elapsedMs)}ms`);
  if (diagnostic?.finishReason && ENUM.test(diagnostic.finishReason)) parts.push(`finish=${diagnostic.finishReason}`);
  if (num(diagnostic?.candidates)) parts.push(`candidates=${num(diagnostic?.candidates)}`);
  const tokens = diagnostic?.tokens;
  if (tokens) {
    const counts = (["prompt", "thoughts", "output"] as const).flatMap((key) => (num(tokens[key]) ? [`${key}:${num(tokens[key])}`] : []));
    if (counts.length) parts.push(`tokens=${counts.join(",")}`);
  }
  if (diagnostic?.discards) parts.push(`discarded=unsupported:${num(diagnostic.discards.unsupported) ?? 0},malformed:${num(diagnostic.discards.malformed) ?? 0}`);
  if (model && isSafeModelName(model)) parts.push(`model=${model}`);
  return parts.join(" ");
}
