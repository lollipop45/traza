// The ACTIVE AI provider: Groq (OpenAI-compatible chat completions, strict structured output),
// against a scripted FAKE fetch and a virtual clock. No network, no real Groq, fake key.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_GROQ_MODEL, readAiConfig } from "@/lib/ai/env";
import { GROQ_ENDPOINT, SCHEMA_NAME, createGroqProvider, reasoningOptions, readResponse, toStrictSchema } from "@/lib/ai/groq";
import { MAX_ATTEMPTS, type RetryRuntime } from "@/lib/ai/retry";
import type { AiRequest } from "@/lib/ai/types";
import { diagnosticLine } from "@/lib/assistant/diagnostics";
import { REPLY_SCHEMA } from "@/lib/assistant/prompt";
import { runAssistantTurn, TURN_ERRORS, type AssistantStore } from "@/lib/assistant/turn";
import type { Proposal } from "@/lib/assistant/types";

const FAKE_KEY = "gsk_FAKE-groq-key-not-real-0123456789abcdef";
const MODEL = "openai/gpt-oss-20b";
const request: AiRequest = {
  system: "Reglas y DATOS privados: Imprimir planos",
  turns: [
    { role: "user", text: "Hola" },
    { role: "model", text: "¿En qué te ayudo?" },
    { role: "user", text: "¿Qué tengo mañana?" },
  ],
  schema: REPLY_SCHEMA,
};

/** A strict-mode action: every field present, unused ones null. */
const action = (fields: Record<string, unknown>) => ({
  type: "create_task",
  title: "",
  date: null,
  startTime: null,
  endTime: null,
  allDay: null,
  location: null,
  description: null,
  content: null,
  priority: null,
  projectRef: null,
  ...fields,
});

const completion = (content: unknown, finishReason = "stop") =>
  Response.json({
    id: "chatcmpl-x",
    object: "chat.completion",
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finishReason }],
    usage: { prompt_tokens: 4200, completion_tokens: 180, completion_tokens_details: { reasoning_tokens: 60 } },
  });

type Step = number | "network" | "timeout" | (() => Response);

function scripted(steps: Step[], model = MODEL) {
  let clock = 0;
  let calls = 0;
  const delays: number[] = [];
  const seen: { url: string; init: RequestInit }[] = [];
  const runtime: RetryRuntime = {
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    now: () => clock,
  };
  const provider = createGroqProvider(
    { apiKey: FAKE_KEY, model },
    async (url, init) => {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls++;
      seen.push({ url, init });
      clock += 100;
      if (step === "network") throw new TypeError(`fetch failed ${FAKE_KEY}`);
      if (step === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (typeof step === "function") return step();
      return Response.json({ error: { message: `upstream detail ${FAKE_KEY}`, type: "invalid_request_error" } }, { status: step });
    },
    runtime,
  );
  return { provider, delays, seen, calls: () => calls };
}

const ok = (content: unknown) => () => completion(content);

function countingStore() {
  const counts = { userMessages: 0, replies: [] as string[], proposals: [] as Proposal[] };
  const store: AssistantStore = {
    resolveConversation: async () => "c1",
    loadHistory: async () => [],
    addUserMessage: async () => {
      counts.userMessages++;
      return true;
    },
    addReply: async (_id, content, proposals) => {
      counts.replies.push(content);
      counts.proposals.push(...proposals);
      return true;
    },
  };
  return { store, counts };
}

const PROJECT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const turn = (provider: ReturnType<typeof scripted>["provider"], store: AssistantStore, text = "Recuérdame imprimir el A1 mañana") =>
  runAssistantTurn(
    {
      store,
      provider,
      loadContext: async () => ({ projects: [{ id: PROJECT_ID, name: "Taller de Proyectos", status: "active", progress: 0 }], tasks: [], events: [], inbox: [] }) as never,
      now: () => new Date("2026-10-07T09:00:00Z"),
    },
    { conversationId: null, text },
  );

// ---------------------------------------------------------------------------

describe("Groq configuration (server-only)", () => {
  it("is enabled only by a server-side GROQ_API_KEY and defaults to openai/gpt-oss-20b", () => {
    assert.equal(DEFAULT_GROQ_MODEL, "openai/gpt-oss-20b");
    assert.equal(readAiConfig({}), null);
    assert.equal(readAiConfig({ NEXT_PUBLIC_GROQ_API_KEY: FAKE_KEY }), null);
    assert.equal(readAiConfig({ GROQ_API_KEY: "short" }), null);
    assert.deepEqual(readAiConfig({ GROQ_API_KEY: FAKE_KEY }), { provider: "groq", apiKey: FAKE_KEY, model: "openai/gpt-oss-20b" });
    assert.equal(readAiConfig({ GROQ_API_KEY: FAKE_KEY, GROQ_MODEL: "openai/gpt-oss-120b" })?.model, "openai/gpt-oss-120b");
    for (const evil of ["../evil", "openai/../x", "a b", "openai/gpt?x=1", "a/b/c", "OPENAI/X"]) {
      assert.equal(readAiConfig({ GROQ_API_KEY: FAKE_KEY, GROQ_MODEL: evil })?.model, DEFAULT_GROQ_MODEL, evil);
    }
  });
});

describe("Groq request", () => {
  it("posts to the chat completions endpoint with a Bearer key in the header only", async () => {
    const fake = scripted([ok({ message: "Hola", actions: [] })]);
    assert.ok((await fake.provider.generate(request)).ok);
    const [{ url, init }] = fake.seen;
    assert.equal(url, GROQ_ENDPOINT);
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${FAKE_KEY}`);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.ok(!String(init.body).includes(FAKE_KEY), "the key is never in the body");
  });

  it("uses the configured model, low reasoning effort, hidden reasoning and no tools", async () => {
    const fake = scripted([ok({ message: "Hola", actions: [] })]);
    await fake.provider.generate(request);
    const body = JSON.parse(String(fake.seen[0].init.body));
    assert.equal(body.model, "openai/gpt-oss-20b");
    assert.equal(body.reasoning_effort, "low");
    // GPT-OSS rejects `reasoning_format`; its reasoning is hidden with include_reasoning: false.
    assert.equal(body.include_reasoning, false);
    assert.equal(body.reasoning_format, undefined);
    assert.equal(body.stream, false);
    for (const forbidden of ["tools", "tool_choice", "functions", "compound_custom", "search_settings"]) assert.equal(body[forbidden], undefined, forbidden);
    assert.deepEqual(
      body.messages.map((m: { role: string }) => m.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(body.messages[0].content, request.system);
  });

  it("sends reasoning_format=hidden to models that support it, and never both reasoning switches", () => {
    assert.deepEqual(reasoningOptions("openai/gpt-oss-20b"), { reasoning_effort: "low", include_reasoning: false });
    assert.deepEqual(reasoningOptions("openai/gpt-oss-120b"), { reasoning_effort: "low", include_reasoning: false });
    assert.deepEqual(reasoningOptions("qwen/qwen3-32b"), { reasoning_format: "hidden" });
    assert.deepEqual(reasoningOptions("llama-3.3-70b-versatile"), {});
    for (const model of ["openai/gpt-oss-20b", "qwen/qwen3-32b", "llama-3.3-70b-versatile"]) {
      const options = reasoningOptions(model);
      assert.ok(!("include_reasoning" in options && "reasoning_format" in options), model);
    }
  });

  it("asks for strict JSON-schema output: every field required, closed objects, nullable unions", async () => {
    const fake = scripted([ok({ message: "Hola", actions: [] })]);
    await fake.provider.generate(request);
    const format = JSON.parse(String(fake.seen[0].init.body)).response_format;
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.name, SCHEMA_NAME);
    assert.equal(format.json_schema.name, "traza_assistant_response");
    assert.equal(format.json_schema.strict, true);

    const schema = format.json_schema.schema;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["message", "actions"]);
    assert.equal(schema.properties.actions.maxItems, undefined, "not sent in strict mode; the app caps proposals");
    const item = schema.properties.actions.items;
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.required, Object.keys(item.properties));
    assert.deepEqual(item.properties.type, { type: "string", enum: ["create_task", "create_event", "create_note", "create_idea"] });
    assert.deepEqual(item.properties.title.type, "string");
    assert.deepEqual(item.properties.date.type, ["string", "null"]);
    assert.deepEqual(item.properties.allDay.type, ["boolean", "null"]);
    assert.deepEqual(item.properties.priority.enum, ["low", "normal", "high", null]);

    // Every object anywhere in the schema is closed and lists all of its properties as required.
    const walk = (node: Record<string, unknown>) => {
      if (node.properties) {
        assert.equal(node.additionalProperties, false);
        assert.deepEqual(node.required, Object.keys(node.properties as object));
        Object.values(node.properties as Record<string, Record<string, unknown>>).forEach(walk);
      }
      if (node.items) walk(node.items as Record<string, unknown>);
    };
    walk(schema);
  });

  it("turns an optional, non-nullable field into a required nullable one", () => {
    assert.deepEqual(toStrictSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] }), {
      type: "object",
      properties: { a: { type: "string" }, b: { type: ["string", "null"] } },
      required: ["a", "b"],
      additionalProperties: false,
    });
  });
});

describe("Groq answers", () => {
  it("returns a valid structured read-only answer through the turn", async () => {
    const fake = scripted([ok({ message: "Mañana no tienes nada.", actions: [] })]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store, "¿Qué tengo mañana?");
    assert.ok(result.ok);
    assert.deepEqual(counts.replies, ["Mañana no tienes nada."]);
    assert.equal(counts.proposals.length, 0);
    assert.equal(result.diagnostic?.stage, null);
    assert.equal(result.diagnostic?.status, 200);
    assert.equal(result.diagnostic?.attempts, 1);
    assert.equal(result.diagnostic?.candidates, 1);
    assert.equal(result.diagnostic?.finishReason, "STOP");
    assert.deepEqual(result.diagnostic?.tokens, { prompt: 4200, thoughts: 60, output: 180 });
  });

  it("proposes one task (nothing is created by the model)", async () => {
    const fake = scripted([ok({ message: "Te propongo esta tarea.", actions: [action({ title: "Imprimir A1", date: "2026-10-08", priority: "high" })] })]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.ok(result.ok);
    assert.equal(counts.proposals.length, 1);
    assert.equal(counts.proposals[0].type, "create_task");
    assert.deepEqual(counts.proposals[0].payload, { title: "Imprimir A1", description: null, due_date: "2026-10-08", priority: "high", project_id: null });
  });

  it("proposes several actions of different types", async () => {
    const fake = scripted([
      ok({
        message: "Te propongo un evento, una tarea y una idea.",
        actions: [
          action({ type: "create_event", title: "Crítica", date: "2026-10-08", startTime: "10:00", endTime: "11:30", allDay: false, projectRef: "P1" }),
          action({ title: "Imprimir A1", date: "2026-10-08" }),
          action({ type: "create_idea", title: "Maqueta en corcho", content: "Probar escala 1:200" }),
        ],
      }),
    ]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store, "Mañana a las 10 tengo crítica, recuérdame imprimir y apunta la idea");
    assert.ok(result.ok);
    assert.deepEqual(
      counts.proposals.map((p) => p.type),
      ["create_event", "create_task", "create_idea"],
    );
    // The project ref is resolved server-side to the user's real project id.
    assert.equal((counts.proposals[0].payload as { project_id: string }).project_id, PROJECT_ID);
  });

  it("application-side validation still rejects invalid actions, even under strict output", async () => {
    const fake = scripted([
      ok({
        message: "Hola",
        actions: [
          action({ title: "Fecha imposible", date: "2026-02-30" }),
          action({ type: "create_event", title: "Sin fecha" }),
          action({ type: "create_event", title: "Al revés", date: "2026-10-08", startTime: "12:00", endTime: "10:00", allDay: false }),
          action({ title: "Proyecto inventado", projectRef: "P9" }),
          action({ type: "delete_task", title: "x" }),
          action({ title: "Válida", date: "2026-10-09" }),
        ],
      }),
    ]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.ok(result.ok);
    assert.deepEqual(
      counts.proposals.map((p) => p.payload.title),
      ["Válida"],
    );
    const discards = result.diagnostic?.discards;
    assert.ok(discards && discards.unsupported === 1 && discards.malformed >= 3, JSON.stringify(discards));
  });

  it("rejects content that is not TRAZA's JSON (validation unchanged)", async () => {
    for (const [content, stage] of [
      ["Mañana tienes…", "invalid_json"],
      [JSON.stringify({ respuesta: "sin message" }), "schema_validation"],
    ]) {
      const fake = scripted([ok(content)]);
      const { store, counts } = countingStore();
      const result = await turn(fake.provider, store);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? null : result.diagnostic?.stage, stage);
      assert.equal(result.ok ? null : result.error, TURN_ERRORS.invalid);
      assert.equal(counts.replies.length, 0);
      assert.equal(fake.calls(), 1, "never retried");
    }
  });
});

describe("Groq malformed responses", () => {
  const stage = (body: unknown) => {
    const result = readResponse(body);
    return result.ok ? "ok" : result.diagnostic?.stage;
  };

  it("rejects a malformed HTTP 200 (not JSON) without retrying", async () => {
    const fake = scripted([() => new Response("<html>bad gateway</html>", { status: 200 })]);
    const result = await fake.provider.generate(request);
    assert.deepEqual(result, { ok: false, kind: "invalid-response", diagnostic: { stage: "unexpected_response", status: 200, attempts: 1, elapsedMs: 100 } });
    assert.equal(fake.calls(), 1);
  });

  it("rejects missing choices", async () => {
    assert.equal(stage({}), "empty_choices");
    assert.equal(stage({ choices: [] }), "empty_choices");
    assert.equal(stage({ choices: "nope" }), "unexpected_response");
    assert.equal(stage("not an object"), "unexpected_response");
    assert.equal(stage({ choices: [{ finish_reason: "stop" }] }), "unexpected_response");
    const fake = scripted([() => Response.json({ id: "x", choices: [] })]);
    const result = await fake.provider.generate(request);
    assert.equal(result.ok ? null : result.diagnostic?.stage, "empty_choices");
    assert.equal(fake.calls(), 1);
  });

  it("rejects empty content", async () => {
    assert.equal(stage({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] }), "empty_text");
    assert.equal(stage({ choices: [{ message: { role: "assistant", content: "   " }, finish_reason: "stop" }] }), "empty_text");
    assert.equal(stage({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] }), "empty_text");
    // Reasoning text, if a provider ever returned it, is never used as the answer.
    assert.equal(stage({ choices: [{ message: { role: "assistant", content: "", reasoning: "pienso…" }, finish_reason: "stop" }] }), "empty_text");
    const fake = scripted([ok("")]);
    const result = await fake.provider.generate(request);
    assert.equal(result.ok ? null : result.diagnostic?.stage, "empty_text");
    assert.equal(fake.calls(), 1);
  });

  it("rejects truncated and filtered answers", () => {
    assert.equal(stage({ choices: [{ message: { content: '{"message":"cort' }, finish_reason: "length" }] }), "max_tokens");
    assert.equal(stage({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }), "safety_block");
    assert.equal(stage({ choices: [{ message: { content: null, refusal: "No." }, finish_reason: "stop" }] }), "safety_block");
    assert.equal(stage({ choices: [{ message: { content: '{"message":"ok","actions":[]}' }, finish_reason: "stop" }] }), "ok");
  });
});

describe("Groq failures and retries", () => {
  const recovering: [string, Step[]][] = [
    ["503 then 200", [503, ok({ message: "Hola", actions: [] })]],
    ["429 then 200", [429, ok({ message: "Hola", actions: [] })]],
    ["408 then 200", [408, ok({ message: "Hola", actions: [] })]],
    ["500, 502, then 200", [500, 502, ok({ message: "Hola", actions: [] })]],
    ["504 then 200", [504, ok({ message: "Hola", actions: [] })]],
    ["network failure then 200", ["network", ok({ message: "Hola", actions: [] })]],
    ["timeout then 200", ["timeout", ok({ message: "Hola", actions: [] })]],
  ];
  for (const [name, steps] of recovering) {
    it(`recovers: ${name}`, async () => {
      const fake = scripted(steps);
      const result = await fake.provider.generate(request);
      assert.ok(result.ok, name);
      assert.equal(result.diagnostic?.attempts, steps.length);
      assert.equal(fake.calls(), steps.length);
      assert.equal(new Set(fake.seen.map((s) => String(s.init.body))).size, 1, "the same request every time");
    });
  }

  it("gives up after exhausted transient retries with a safe failure", async () => {
    const fake = scripted([503]);
    const result = await fake.provider.generate(request);
    assert.deepEqual(result, { ok: false, kind: "unavailable", diagnostic: { stage: "provider_5xx", status: 503, attempts: MAX_ATTEMPTS, elapsedMs: 4 * 100 + 1000 + 2000 + 4000 } });
    assert.deepEqual(fake.delays, [1000, 2000, 4000]);
    assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
  });

  const final: [string, number, string, string][] = [
    ["400", 400, "http_400", "rejected"],
    ["401", 401, "http_401", "rejected"],
    ["403", 403, "http_403", "rejected"],
  ];
  for (const [name, status, stageName, kind] of final) {
    it(`${name} does not retry`, async () => {
      const fake = scripted([status, ok({ message: "Hola", actions: [] })]);
      const result = await fake.provider.generate(request);
      assert.deepEqual(result, { ok: false, kind, diagnostic: { stage: stageName, status, attempts: 1, elapsedMs: 100 } });
      assert.equal(fake.calls(), 1);
      assert.deepEqual(fake.delays, []);
      assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
    });
  }

  it("a retried request stores one user message, one reply and each proposal once", async () => {
    const fake = scripted([503, 429, ok({ message: "Te propongo esta tarea.", actions: [action({ title: "Imprimir A1", date: "2026-10-08" })] })]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.ok(result.ok);
    assert.equal(result.diagnostic?.attempts, 3);
    assert.deepEqual([counts.userMessages, counts.replies.length, counts.proposals.length], [1, 1, 1]);
  });

  it("exhausted retries through the turn keep only the user's message", async () => {
    const fake = scripted([503]);
    const { store, counts } = countingStore();
    const result = await turn(fake.provider, store);
    assert.equal(result.ok ? null : result.error, TURN_ERRORS.unavailable);
    assert.deepEqual([counts.userMessages, counts.replies.length, counts.proposals.length], [1, 0, 0]);
  });
});

describe("Groq diagnostics (development only)", () => {
  it("formats the safe line with provider, attempts and elapsed time", () => {
    assert.equal(diagnosticLine({ stage: null, status: 200, attempts: 1 }, MODEL, "groq"), "provider=groq stage=none status=200 attempts=1 model=openai/gpt-oss-20b");
    assert.equal(
      diagnosticLine({ stage: "provider_5xx", status: 503, attempts: 4, elapsedMs: 7400 }, MODEL, "groq"),
      "provider=groq stage=provider_5xx status=503 attempts=4 elapsed=7400ms model=openai/gpt-oss-20b",
    );
    assert.equal(diagnosticLine({ stage: null }, `x ${FAKE_KEY}`, `groq ${FAKE_KEY}`), "stage=none");
  });
});

// ---------------------------------------------------------------------------
// No secrets in browser code
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
function files(dir: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, accept) : accept(full) ? [full] : [];
  });
}

describe("no AI secrets in browser code", () => {
  it("no client component imports the AI provider layer, and the provider entry is server-only", () => {
    const sources = [...files(path.join(ROOT, "app"), (f) => /\.tsx?$/.test(f)), ...files(path.join(ROOT, "components"), (f) => /\.tsx?$/.test(f))];
    const clientFiles = sources.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    assert.ok(clientFiles.length > 0);
    for (const file of clientFiles) {
      const text = readFileSync(file, "utf8");
      assert.ok(!/from\s+["']@\/lib\/ai\//.test(text), `${path.relative(ROOT, file)} imports lib/ai`);
      assert.ok(!/GROQ_API_KEY|GEMINI_API_KEY/.test(text), path.relative(ROOT, file));
    }
    assert.match(readFileSync(path.join(ROOT, "lib/ai/provider.ts"), "utf8"), /^import "server-only";/);
    const everything = [...sources, ...files(path.join(ROOT, "lib"), (f) => /\.tsx?$/.test(f))].map((f) => readFileSync(f, "utf8")).join("\n");
    assert.ok(!/NEXT_PUBLIC_(GROQ|GEMINI)/.test(everything), "no public AI variables");
  });

  it("the built browser bundle (if present) has no key name, endpoint or diagnostic text", () => {
    const bundle = files(path.join(ROOT, ".next", "static"), (f) => f.endsWith(".js"));
    if (bundle.length === 0) return; // Not built yet; `npm run build` then re-run to check.
    const text = bundle.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const needle of ["GROQ_API_KEY", "api.groq.com", "GEMINI_API_KEY", "generativelanguage", "assistant diagnostic", "gsk_"]) {
      assert.ok(!text.includes(needle), needle);
    }
  });
});
