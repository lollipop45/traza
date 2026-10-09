// The shared bounded retry policy (lib/ai/retry.ts), exercised through the active Groq adapter, against a
// scripted FAKE fetch and a virtual clock (no real waiting, no network, fake key). Also checks that
// retries never duplicate assistant messages or proposals.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGroqProvider } from "@/lib/ai/groq";
import { ATTEMPT_TIMEOUT_MS, MAX_ATTEMPTS, RETRY_JITTER, TOTAL_TIMEOUT_MS, retryDelay, type RetryRuntime } from "@/lib/ai/retry";
import type { AiRequest } from "@/lib/ai/types";
import { REPLY_SCHEMA } from "@/lib/assistant/prompt";
import { runAssistantTurn, TURN_ERRORS, type AssistantStore } from "@/lib/assistant/turn";
import type { Proposal } from "@/lib/assistant/types";

const FAKE_KEY = "gsk_FAKE-groq-key-not-real-0123456789abcdef";
const request: AiRequest = { system: "Reglas", turns: [{ role: "user", text: "¿Qué tengo mañana?" }], schema: REPLY_SCHEMA };
const ANSWER = JSON.stringify({ message: "Mañana tienes «Imprimir planos».", actions: [] });

/** One scripted attempt: an HTTP status, a valid answer, or a thrown network / timeout error. */
type Step = number | "ok" | "network" | "timeout" | "malformed" | "safety" | "max_tokens" | { text: string };

const completion = (content: string, finishReason = "stop") =>
  Response.json({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }] });

function scripted(steps: Step[], options: { attemptMs?: number } = {}) {
  let clock = 0;
  const delays: number[] = [];
  const bodies: string[] = [];
  let calls = 0;
  const runtime: RetryRuntime = {
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    now: () => clock,
  };
  const provider = createGroqProvider(
    { apiKey: FAKE_KEY, model: "openai/gpt-oss-20b" },
    async (_url, init) => {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls++;
      bodies.push(String(init.body));
      clock += options.attemptMs ?? 100;
      if (step === "network") throw new TypeError("fetch failed");
      if (step === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (step === "ok") return completion(ANSWER);
      if (step === "malformed") return new Response("<html>not json</html>", { status: 200 });
      if (step === "safety") return completion("", "content_filter");
      if (step === "max_tokens") return completion('{"message":"cort', "length");
      if (typeof step === "object") return completion(step.text);
      return Response.json({ error: { message: `upstream detail ${FAKE_KEY}` } }, { status: step });
    },
    runtime,
  );
  return { provider, delays, bodies, calls: () => calls, elapsed: () => clock };
}

describe("retries: transient failures recover", () => {
  const recovering: [string, Step[], number][] = [
    ["503 then 200", [503, "ok"], 2],
    ["503, 503, then 200", [503, 503, "ok"], 3],
    ["429 then 200", [429, "ok"], 2],
    ["408 then 200", [408, "ok"], 2],
    ["500 then 200", [500, "ok"], 2],
    ["502 then 200", [502, "ok"], 2],
    ["504 then 200", [504, "ok"], 2],
    ["network failure then success", ["network", "ok"], 2],
    ["timeout then success", ["timeout", "ok"], 2],
  ];
  for (const [name, steps, attempts] of recovering) {
    it(name, async () => {
      const fake = scripted(steps);
      const result = await fake.provider.generate(request);
      assert.ok(result.ok, name);
      assert.equal(result.text, ANSWER);
      assert.equal(result.diagnostic?.attempts, attempts);
      assert.equal(result.diagnostic?.stage, null);
      assert.equal(fake.calls(), attempts);
      // The same request every time.
      assert.equal(new Set(fake.bodies).size, 1);
    });
  }

  it("waits about 1 s, 2 s and 4 s between attempts", async () => {
    const fake = scripted([503, 503, 503, "ok"]);
    const result = await fake.provider.generate(request);
    assert.ok(result.ok);
    assert.equal(result.diagnostic?.attempts, 4);
    assert.deepEqual(fake.delays, [1000, 2000, 4000]);
  });

  it("keeps jitter bounded (±25 %)", () => {
    for (const [retry, base] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ] as const) {
      assert.equal(retryDelay(retry, 0), base * (1 - RETRY_JITTER));
      assert.equal(retryDelay(retry, 0.5), base);
      assert.ok(retryDelay(retry, 0.9999) <= base * (1 + RETRY_JITTER));
      assert.equal(retryDelay(retry, 7), base * (1 + RETRY_JITTER), "out-of-range randomness is clamped");
    }
  });
});

describe("retries: bounded", () => {
  it("gives up after four 503 attempts with the existing safe failure", async () => {
    const fake = scripted([503]);
    const result = await fake.provider.generate(request);
    assert.deepEqual(result, { ok: false, kind: "unavailable", diagnostic: { stage: "provider_5xx", status: 503, attempts: MAX_ATTEMPTS, elapsedMs: 4 * 100 + 1000 + 2000 + 4000 } });
    assert.equal(fake.calls(), MAX_ATTEMPTS);
    assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
  });

  it("never exceeds the total time budget, even with slow attempts", async () => {
    // Each attempt takes the full per-attempt limit: 20 s + 1 s + 20 s + 2 s + 20 s = 63 s, so a
    // fourth attempt would not fit in 60 s and is not started.
    const fake = scripted(["timeout"], { attemptMs: ATTEMPT_TIMEOUT_MS });
    const result = await fake.provider.generate(request);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.diagnostic?.stage, "timeout");
    assert.equal(fake.calls(), 3);
    assert.ok(fake.elapsed() <= TOTAL_TIMEOUT_MS + ATTEMPT_TIMEOUT_MS);
  });
});

describe("retries: never for permanent or content failures", () => {
  const final: [string, Step, string][] = [
    ["400 never retries", 400, "http_400"],
    ["401 never retries", 401, "http_401"],
    ["403 never retries", 403, "http_403"],
    ["501 never retries", 501, "provider_5xx"],
    ["malformed HTTP 200 never retries", "malformed", "unexpected_response"],
    ["a content-filter block never retries", "safety", "safety_block"],
    ["a truncated answer never retries", "max_tokens", "max_tokens"],
  ];
  for (const [name, step, stage] of final) {
    it(name, async () => {
      const fake = scripted([step, "ok"]);
      const result = await fake.provider.generate(request);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? null : result.diagnostic?.stage, stage);
      assert.equal(result.ok ? null : result.diagnostic?.attempts, 1);
      assert.equal(fake.calls(), 1);
      assert.deepEqual(fake.delays, []);
    });
  }
});

// ---------------------------------------------------------------------------
// Through the assistant turn: retries never duplicate messages or proposals
// ---------------------------------------------------------------------------

function countingStore() {
  const counts = { conversations: 0, userMessages: 0, replies: 0, proposals: [] as Proposal[] };
  const store: AssistantStore = {
    resolveConversation: async () => {
      counts.conversations++;
      return "c1";
    },
    loadHistory: async () => [],
    addUserMessage: async () => {
      counts.userMessages++;
      return true;
    },
    addReply: async (_id, _content, proposals) => {
      counts.replies++;
      counts.proposals.push(...proposals);
      return true;
    },
  };
  return { store, counts };
}

const turn = (provider: ReturnType<typeof scripted>["provider"], store: AssistantStore) =>
  runAssistantTurn(
    { store, provider, loadContext: async () => ({ projects: [], tasks: [], events: [], inbox: [] }), now: () => new Date("2026-10-07T09:00:00Z") },
    { conversationId: null, text: "Recuérdame imprimir el A1 mañana" },
  );

describe("retries through the assistant turn", () => {
  it("a recovered request stores one user message, one reply and each proposal once", async () => {
    const answer = JSON.stringify({ message: "Te propongo esta tarea.", actions: [{ type: "create_task", title: "Imprimir A1", date: "2026-10-08" }] });
    const fake = scripted([503, 503, { text: answer }]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.ok(result.ok);
    assert.equal(result.diagnostic?.attempts, 3);
    assert.deepEqual([counts.conversations, counts.userMessages, counts.replies, counts.proposals.length], [1, 1, 1, 1]);
  });

  it("exhausted retries keep only the user's message and the safe Spanish error", async () => {
    const fake = scripted([503]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.deepEqual(result, {
      ok: false,
      error: TURN_ERRORS.unavailable,
      conversationId: "c1",
      diagnostic: { stage: "provider_5xx", status: 503, attempts: 4, elapsedMs: 7400 },
    });
    assert.deepEqual([counts.userMessages, counts.replies, counts.proposals.length], [1, 0, 0]);
  });

  it("a schema-validation failure is not retried (the provider call succeeded)", async () => {
    const fake = scripted([{ text: JSON.stringify({ respuesta: "sin message" }) }, "ok"]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.diagnostic?.stage, "schema_validation");
    assert.equal(fake.calls(), 1);
    assert.equal(counts.replies, 0);
  });

  it("unsupported or malformed actions are not retried either", async () => {
    const answer = JSON.stringify({ message: "Hola", actions: [{ type: "delete_task", title: "x" }, { type: "create_task", title: "Mal", date: "2026-02-30" }] });
    const fake = scripted([{ text: answer }, "ok"]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.ok(result.ok);
    assert.deepEqual(result.diagnostic?.discards, { unsupported: 1, malformed: 1 });
    assert.equal(fake.calls(), 1);
    assert.deepEqual([counts.replies, counts.proposals.length], [1, 0]);
  });
});
