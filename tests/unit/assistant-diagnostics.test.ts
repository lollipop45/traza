// The provider path's safe failure stages (through the active Groq adapter) and the DEVELOPMENT-ONLY
// diagnostics of the assistant turn. Fake fetch / fake provider only; no network, fake key.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGroqProvider } from "@/lib/ai/groq";
import type { AiProvider, AiRequest, AiResult } from "@/lib/ai/types";
import { diagnosticLine } from "@/lib/assistant/diagnostics";
import { REPLY_SCHEMA } from "@/lib/assistant/prompt";
import { analyzeReply } from "@/lib/assistant/response";
import { runAssistantTurn, TURN_ERRORS, type AssistantStore } from "@/lib/assistant/turn";

const FAKE_KEY = "gsk_FAKE-groq-key-not-real-0123456789abcdef";
const request: AiRequest = { system: "Reglas y DATOS privados: Imprimir planos", turns: [{ role: "user", text: "¿Qué tengo mañana?" }], schema: REPLY_SCHEMA };
const refs = { projectRefs: new Map<string, string>(), projectIds: new Set<string>() };

function provider(respond: () => Response | Promise<Response>) {
  return createGroqProvider({ apiKey: FAKE_KEY, model: "openai/gpt-oss-20b" }, async () => respond(), { sleep: async () => {}, random: () => 0.5, now: () => 0 });
}

describe("provider failure stages", () => {
  it("maps HTTP and network failures to stages, with the status only", async () => {
    // Transient statuses are retried until the attempts run out (4); the others are final at once.
    const cases: [() => Response, string, number, number][] = [
      [() => Response.json({ error: { message: `bad ${FAKE_KEY}` } }, { status: 400 }), "http_400", 400, 1],
      [() => Response.json({}, { status: 401 }), "http_401", 401, 1],
      [() => Response.json({}, { status: 403 }), "http_403", 403, 1],
      [() => Response.json({}, { status: 408 }), "http_408", 408, 4],
      [() => Response.json({}, { status: 429 }), "http_429", 429, 4],
      [() => Response.json({}, { status: 503 }), "provider_5xx", 503, 4],
      [() => Response.json({}, { status: 501 }), "provider_5xx", 501, 1],
      [() => Response.json({}, { status: 404 }), "unexpected_response", 404, 1],
      [() => new Response("<html>", { status: 200 }), "unexpected_response", 200, 1],
    ];
    for (const [respond, stage, status, attempts] of cases) {
      const result = await provider(respond).generate(request);
      assert.equal(result.ok, false);
      assert.deepEqual(result.ok ? null : result.diagnostic, { stage, status, attempts, elapsedMs: 0 });
      assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
    }
    const network = await provider(() => {
      throw new TypeError("fetch failed");
    }).generate(request);
    assert.equal(network.ok ? null : network.diagnostic?.stage, "request_failed");
    const timeout = await provider(() => {
      throw new DOMException("timed out", "TimeoutError");
    }).generate(request);
    assert.equal(timeout.ok ? null : timeout.diagnostic?.stage, "timeout");
  });
});

describe("reply validation stages", () => {
  it("names why a whole answer was rejected", () => {
    assert.deepEqual(analyzeReply("Mañana tienes…", refs), { ok: false, stage: "invalid_json" });
    assert.deepEqual(analyzeReply('{"message":"cortado', refs), { ok: false, stage: "invalid_json" });
    for (const body of [[], { actions: [] }, { message: "" }, { message: 3 }, { message: "ok", actions: {} }]) {
      assert.deepEqual(analyzeReply(JSON.stringify(body), refs), { ok: false, stage: "schema_validation" }, JSON.stringify(body));
    }
  });

  it("counts unsupported and malformed actions separately (validation unchanged)", () => {
    const analyzed = analyzeReply(
      JSON.stringify({
        message: "Hola",
        actions: [{ type: "delete_task", title: "x" }, { type: "create_task", title: "ok", date: "2026-02-30" }, { type: "create_task", title: "Bien" }],
      }),
      refs,
    );
    assert.ok(analyzed.ok);
    assert.deepEqual(analyzed.reply.discards, { unsupported: 1, malformed: 1 });
    assert.equal(analyzed.reply.proposals.length, 1);
  });
});

describe("turn diagnostics", () => {
  const store: AssistantStore = {
    resolveConversation: async () => "c1",
    loadHistory: async () => [],
    addUserMessage: async () => true,
    addReply: async () => true,
  };
  const deps = (answer: AiResult) => ({
    store,
    provider: { generate: async () => answer } satisfies AiProvider,
    loadContext: async () => ({ projects: [], tasks: [], events: [], inbox: [] }),
    now: () => new Date("2026-10-06T10:00:00Z"),
  });

  it("carries the provider stage and the validation stage out of the turn", async () => {
    const maxTokens = await runAssistantTurn(deps({ ok: false, kind: "invalid-response", diagnostic: { stage: "max_tokens", finishReason: "MAX_TOKENS", candidates: 1 } }), { conversationId: null, text: "¿Qué tengo mañana?" });
    assert.deepEqual(maxTokens, { ok: false, error: TURN_ERRORS.invalid, conversationId: "c1", diagnostic: { stage: "max_tokens", finishReason: "MAX_TOKENS", candidates: 1 } });

    const badJson = await runAssistantTurn(deps({ ok: true, text: "no json", diagnostic: { stage: null, finishReason: "STOP" } }), { conversationId: null, text: "Hola" });
    assert.equal(badJson.ok ? null : badJson.diagnostic?.stage, "invalid_json");

    const discarded = await runAssistantTurn(deps({ ok: true, text: JSON.stringify({ message: "Hola", actions: [{ type: "delete_task", title: "x" }] }) }), { conversationId: null, text: "Hola" });
    assert.deepEqual(discarded.ok && discarded.diagnostic, { stage: "unsupported_action", discards: { unsupported: 1, malformed: 0 } });
  });

  it("formats a safe one-line diagnostic: whitelisted fields only", () => {
    assert.equal(
      diagnosticLine({ stage: "max_tokens", status: 200, finishReason: "MAX_TOKENS", candidates: 1, tokens: { prompt: 9120, thoughts: 2000, output: 48 } }, "openai/gpt-oss-20b"),
      "stage=max_tokens status=200 finish=MAX_TOKENS candidates=1 tokens=prompt:9120,thoughts:2000,output:48 model=openai/gpt-oss-20b",
    );
    assert.equal(diagnosticLine({ stage: "provider_5xx", status: 503, attempts: 4 }, "llama-3.3-70b-versatile"), "stage=provider_5xx status=503 attempts=4 model=llama-3.3-70b-versatile");
    // Anything outside the vocabulary is dropped, so no text can leak through the line.
    const hostile = diagnosticLine({ stage: `x ${FAKE_KEY}` as never, finishReason: "Imprimir planos", status: Number.NaN }, "../evil model");
    assert.equal(hostile, "stage=none");
    assert.equal(diagnosticLine(undefined, null), "stage=none");
  });
});
