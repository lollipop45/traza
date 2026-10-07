// The (inactive) Gemini request budget (root cause of the first real failure: thinking tokens exhausting
// maxOutputTokens) and the DEVELOPMENT-ONLY diagnostics of the provider path. Fake fetch / fake
// provider only; no network, fake key.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_OUTPUT_TOKENS, THINKING_BUDGET, createGeminiProvider, readResponse, requestBody } from "@/lib/ai/gemini";
import type { AiProvider, AiRequest, AiResult } from "@/lib/ai/types";
import { diagnosticLine } from "@/lib/assistant/diagnostics";
import { REPLY_SCHEMA } from "@/lib/assistant/prompt";
import { analyzeReply } from "@/lib/assistant/response";
import { runAssistantTurn, TURN_ERRORS, type AssistantStore } from "@/lib/assistant/turn";

const FAKE_KEY = "AIzaFAKE-gemini-key-not-real-0123456789";
const request: AiRequest = { system: "Reglas y DATOS privados: Imprimir planos", turns: [{ role: "user", text: "¿Qué tengo mañana?" }], schema: REPLY_SCHEMA };
const refs = { projectRefs: new Map<string, string>(), projectIds: new Set<string>() };

const candidate = (finishReason: string, parts: unknown[], usage: Record<string, number> = {}) =>
  Response.json({ candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata: usage });

function provider(respond: () => Response | Promise<Response>) {
  return createGeminiProvider({ apiKey: FAKE_KEY, model: "gemini-2.5-flash" }, async () => respond(), { sleep: async () => {}, random: () => 0.5, now: () => 0 });
}

describe("Gemini request budget (root cause)", () => {
  it("bounds thinking and leaves room for the JSON answer on Gemini 2.5", () => {
    const config = requestBody("gemini-2.5-flash", request).generationConfig as Record<string, unknown>;
    assert.deepEqual(config.thinkingConfig, { thinkingBudget: THINKING_BUDGET });
    assert.equal(config.maxOutputTokens, MAX_OUTPUT_TOKENS);
    assert.ok(MAX_OUTPUT_TOKENS - THINKING_BUDGET >= 4096, "thinking can never consume the answer's budget");
    assert.equal(config.responseMimeType, "application/json");
    assert.equal((config.responseSchema as Record<string, unknown>).type, "OBJECT");
  });

  it("does not send thinkingConfig to models that do not accept a thinking budget", () => {
    for (const model of ["gemini-2.0-flash", "gemini-1.5-pro"]) {
      const config = requestBody(model, request).generationConfig as Record<string, unknown>;
      assert.equal(config.thinkingConfig, undefined, model);
    }
    assert.ok((requestBody("gemini-2.5-pro", request).generationConfig as Record<string, unknown>).thinkingConfig);
  });
});

describe("Gemini response stages", () => {
  it("reports the old failure precisely: thinking used the budget, the answer was cut (max_tokens)", () => {
    const truncated = readResponse({
      candidates: [{ content: { parts: [{ text: '{"message":"Mañana tienes' }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 9120, thoughtsTokenCount: 2000, candidatesTokenCount: 48 },
    });
    assert.deepEqual(truncated, {
      ok: false,
      kind: "invalid-response",
      diagnostic: { stage: "max_tokens", candidates: 1, finishReason: "MAX_TOKENS", tokens: { prompt: 9120, thoughts: 2000, output: 48 } },
    });
    const noParts = readResponse({ candidates: [{ content: { role: "model" }, finishReason: "MAX_TOKENS" }] });
    assert.equal(noParts.ok ? null : noParts.diagnostic?.stage, "max_tokens");
  });

  it("distinguishes empty candidates, safety blocks and empty text", () => {
    const stage = (body: unknown) => {
      const result = readResponse(body);
      return result.ok ? "ok" : result.diagnostic?.stage;
    };
    assert.equal(stage({ candidates: [] }), "empty_candidates");
    assert.equal(stage({}), "empty_candidates");
    assert.equal(stage({ promptFeedback: { blockReason: "SAFETY" } }), "safety_block");
    for (const reason of ["SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST", "SPII"]) assert.equal(stage({ candidates: [{ finishReason: reason }] }), "safety_block", reason);
    assert.equal(stage({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }), "empty_text");
    assert.equal(stage({ candidates: [{ content: { parts: [{ text: "pensando", thought: true }] }, finishReason: "STOP" }] }), "empty_text");
    assert.equal(stage("not an object"), "unexpected_response");
    assert.equal(stage({ candidates: [{ content: { parts: [{ text: '{"message":"ok","actions":[]}' }] }, finishReason: "STOP" }] }), "ok");
  });

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

  it("succeeds with safe metadata on a normal answer", async () => {
    const result = await provider(() => candidate("STOP", [{ text: '{"message":"Mañana no tienes nada.","actions":[]}' }], { promptTokenCount: 5000, thoughtsTokenCount: 300, candidatesTokenCount: 20 })).generate(request);
    assert.ok(result.ok);
    assert.deepEqual(result.diagnostic, { stage: null, candidates: 1, finishReason: "STOP", tokens: { prompt: 5000, thoughts: 300, output: 20 }, status: 200, attempts: 1, elapsedMs: 0 });
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
      diagnosticLine({ stage: "max_tokens", status: 200, finishReason: "MAX_TOKENS", candidates: 1, tokens: { prompt: 9120, thoughts: 2000, output: 48 } }, "gemini-2.5-flash"),
      "stage=max_tokens status=200 finish=MAX_TOKENS candidates=1 tokens=prompt:9120,thoughts:2000,output:48 model=gemini-2.5-flash",
    );
    assert.equal(diagnosticLine({ stage: "provider_5xx", status: 503, attempts: 4 }, "gemini-3.8-flash"), "stage=provider_5xx status=503 attempts=4 model=gemini-3.8-flash");
    // Anything outside the vocabulary is dropped, so no text can leak through the line.
    const hostile = diagnosticLine({ stage: `x ${FAKE_KEY}` as never, finishReason: "Imprimir planos", status: Number.NaN }, "../evil model");
    assert.equal(hostile, "stage=none");
    assert.equal(diagnosticLine(undefined, null), "stage=none");
  });
});
