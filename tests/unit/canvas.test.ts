// Canvas integration tests against a local mock Canvas server (127.0.0.1, real HTTP): no internet
// and no real credentials. The token below is a fake fixture.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  canvasApiUrl,
  canvasRequestHeaders,
  classifyStatus,
  createCanvasClient,
  isSameCanvasApi,
  parseNextLink,
  type FetchLike,
} from "@/lib/canvas/client";
import { isPlausibleCanvasToken, normalizeCanvasBaseUrl, readCanvasConfig } from "@/lib/canvas/env";
import { parseCourse, parseCourses, parseProfile, selectActiveCourses } from "@/lib/canvas/parse";
import { readCanvasOverview } from "@/lib/canvas/read";
import { CanvasError } from "@/lib/canvas/types";

const FAKE_TOKEN = "1234~FAKE-test-token-not-real-0000";

describe("Canvas configuration", () => {
  it("reports missing variables without echoing anything", () => {
    assert.deepEqual(readCanvasConfig({}), { ok: false, problem: "missing" });
    assert.deepEqual(readCanvasConfig({ CANVAS_BASE_URL: "https://campus.example.edu" }), { ok: false, problem: "missing" });
    assert.deepEqual(readCanvasConfig({ CANVAS_ACCESS_TOKEN: FAKE_TOKEN }), { ok: false, problem: "missing" });
    assert.deepEqual(readCanvasConfig({ CANVAS_BASE_URL: "  ", CANVAS_ACCESS_TOKEN: FAKE_TOKEN }), { ok: false, problem: "missing" });
  });

  it("ignores NEXT_PUBLIC_ variants: the token is only read from the server-only name", () => {
    assert.deepEqual(
      readCanvasConfig({ NEXT_PUBLIC_CANVAS_BASE_URL: "https://campus.example.edu", NEXT_PUBLIC_CANVAS_ACCESS_TOKEN: FAKE_TOKEN }),
      { ok: false, problem: "missing" },
    );
  });

  it("normalises and validates the base URL", () => {
    assert.equal(normalizeCanvasBaseUrl("https://campus.example.edu"), "https://campus.example.edu");
    assert.equal(normalizeCanvasBaseUrl(" https://campus.example.edu/// "), "https://campus.example.edu");
    assert.equal(normalizeCanvasBaseUrl("https://campus.example.edu/api/v1/"), "https://campus.example.edu");
    assert.equal(normalizeCanvasBaseUrl("https://example.edu/canvas/"), "https://example.edu/canvas");
    assert.equal(normalizeCanvasBaseUrl("HTTPS://Campus.Example.EDU"), "https://campus.example.edu");
    assert.equal(normalizeCanvasBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    for (const bad of ["campus.example.edu", "http://campus.example.edu", "ftp://campus.example.edu", "https://user:pass@campus.example.edu", "https://campus.example.edu/?x=1", "https://campus.example.edu/#a", "javascript:alert(1)", ""]) {
      assert.equal(normalizeCanvasBaseUrl(bad), null, bad);
    }
  });

  it("validates the token format", () => {
    assert.equal(isPlausibleCanvasToken(FAKE_TOKEN), true);
    for (const bad of ["short", "has space inside the token", "line\nbreak-injection-token", "x".repeat(513)]) {
      assert.equal(isPlausibleCanvasToken(bad), false, JSON.stringify(bad));
    }
    assert.deepEqual(readCanvasConfig({ CANVAS_BASE_URL: "https://campus.example.edu", CANVAS_ACCESS_TOKEN: "bad token value" }), {
      ok: false,
      problem: "invalid-token",
    });
    assert.deepEqual(readCanvasConfig({ CANVAS_BASE_URL: "not a url", CANVAS_ACCESS_TOKEN: FAKE_TOKEN }), { ok: false, problem: "invalid-base-url" });
    assert.deepEqual(readCanvasConfig({ CANVAS_BASE_URL: "https://campus.example.edu/", CANVAS_ACCESS_TOKEN: ` ${FAKE_TOKEN} ` }), {
      ok: true,
      config: { baseUrl: "https://campus.example.edu", token: FAKE_TOKEN },
    });
  });
});

describe("Canvas request building", () => {
  it("builds API URLs without double slashes, with repeated array params", () => {
    assert.equal(canvasApiUrl("https://c.example.edu/", "/users/self"), "https://c.example.edu/api/v1/users/self");
    assert.equal(
      canvasApiUrl("https://c.example.edu/canvas", "courses", { per_page: 100, enrollment_state: "active", "include[]": ["term", "x"] }),
      "https://c.example.edu/canvas/api/v1/courses?per_page=100&enrollment_state=active&include%5B%5D=term&include%5B%5D=x",
    );
  });

  it("sends the token only as a Bearer Authorization header, and asks for string ids", () => {
    assert.deepEqual(canvasRequestHeaders(FAKE_TOKEN), {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      Accept: "application/json+canvas-string-ids",
    });
  });

  it("refuses redirects and never puts the token in the URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "1", name: "Ana" }), { status: 200 });
    };
    await createCanvasClient({ baseUrl: "https://c.example.edu", token: FAKE_TOKEN }, { fetch: fakeFetch }).getJson("users/self");
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes(FAKE_TOKEN));
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.method, "GET");
    assert.ok(calls[0].init.signal);
  });

  it("classifies statuses", () => {
    assert.equal(classifyStatus(401), "unauthorized");
    assert.equal(classifyStatus(403), "forbidden");
    assert.equal(classifyStatus(302), "redirected");
    assert.equal(classifyStatus(429), "unavailable");
    assert.equal(classifyStatus(500), "unavailable");
    assert.equal(classifyStatus(404), "invalid-response");
  });

  it("keeps error messages free of URLs, bodies and tokens", () => {
    const error = new CanvasError("unauthorized", 401);
    assert.equal(error.message, "Canvas request failed: unauthorized (401)");
  });
});

describe("Canvas Link pagination helpers", () => {
  it("extracts rel=next among other relations", () => {
    const header =
      '<https://c.example.edu/api/v1/courses?page=1&per_page=2>; rel="current",<https://c.example.edu/api/v1/courses?page=2&per_page=2>; rel="next", <https://c.example.edu/api/v1/courses?page=3&per_page=2>; rel="last"';
    assert.equal(parseNextLink(header), "https://c.example.edu/api/v1/courses?page=2&per_page=2");
    assert.equal(parseNextLink('<https://c.example.edu/api/v1/courses?page=3>; rel="last"'), null);
    assert.equal(parseNextLink(null), null);
    assert.equal(parseNextLink("garbage"), null);
  });

  it("only follows links on the configured Canvas API", () => {
    assert.equal(isSameCanvasApi("https://c.example.edu", "https://c.example.edu/api/v1/courses?page=2"), true);
    assert.equal(isSameCanvasApi("https://c.example.edu", "https://evil.example.com/api/v1/courses?page=2"), false);
    assert.equal(isSameCanvasApi("https://c.example.edu", "http://c.example.edu/api/v1/courses?page=2"), false);
    assert.equal(isSameCanvasApi("https://c.example.edu", "https://c.example.edu/login?next=/api/v1/"), false);
    assert.equal(isSameCanvasApi("https://c.example.edu/canvas", "https://c.example.edu/api/v1/courses"), false);
  });
});

describe("Canvas response projection", () => {
  it("projects the profile, ignoring other fields", () => {
    assert.deepEqual(parseProfile({ id: "42", name: "Ana López", short_name: "Ana", primary_email: "x@example.edu" }), {
      id: "42",
      name: "Ana López",
      shortName: "Ana",
    });
    assert.deepEqual(parseProfile({ id: 42, name: "Ana", short_name: "Ana" }), { id: "42", name: "Ana", shortName: null });
    assert.equal(parseProfile({ id: "42" }), null);
    assert.equal(parseProfile("<html>"), null);
    assert.equal(parseProfile(null), null);
  });

  it("projects courses with optional fields missing or malformed", () => {
    assert.deepEqual(
      parseCourse({
        id: "10000000012345",
        name: "Taller de Proyectos IV",
        course_code: "TP4",
        workflow_state: "available",
        start_at: null,
        term: { id: "7", name: "2026-27 · 1er cuatrimestre", start_at: "2026-09-14T00:00:00Z" },
        enrollments: [{ type: "student", enrollment_state: "active", role: "StudentEnrollment" }],
      }),
      {
        id: "10000000012345",
        name: "Taller de Proyectos IV",
        courseCode: "TP4",
        workflowState: "available",
        startAt: null,
        endAt: null,
        term: { id: "7", name: "2026-27 · 1er cuatrimestre", startAt: "2026-09-14T00:00:00Z", endAt: null },
        enrollments: [{ type: "student", state: "active" }],
        accessRestricted: false,
      },
    );
    const minimal = parseCourse({ id: 99, name: 5, term: "x", enrollments: "x" });
    assert.deepEqual(minimal, {
      id: "99",
      name: null,
      courseCode: null,
      workflowState: null,
      startAt: null,
      endAt: null,
      term: null,
      enrollments: [],
      accessRestricted: false,
    });
    assert.equal(parseCourse({ name: "Sin id" }), null);
    assert.equal(parseCourse({ id: "12a" }), null);
    assert.equal(parseCourse({ id: 1.5 }), null);
  });

  it("drops unreadable entries without failing the list", () => {
    const { courses, skipped } = parseCourses([{ id: "1", name: "A" }, null, "x", { id: "2", name: "B" }]);
    assert.deepEqual(courses.map((c) => c.id), ["1", "2"]);
    assert.equal(skipped, 2);
  });

  it("selects active, available courses by id, keeping restricted ones apart", () => {
    const { courses } = parseCourses([
      { id: "3", name: "Estructuras", workflow_state: "available", enrollments: [{ enrollment_state: "active" }] },
      { id: "1", name: "Astronomía", workflow_state: "available" },
      { id: "4", name: "Estructuras", workflow_state: "available" },
      { id: "2", name: "Antiguo", workflow_state: "completed" },
      { id: "5", name: "Borrador", workflow_state: "unpublished" },
      { id: "6", name: "Invitación", workflow_state: "available", enrollments: [{ enrollment_state: "invited" }] },
      { id: "7", access_restricted_by_date: true },
    ]);
    const { active, restricted } = selectActiveCourses(courses);
    assert.deepEqual(active.map((c) => c.id), ["1", "3", "4"]);
    assert.deepEqual(restricted.map((c) => c.id), ["7"]);
  });
});

// --- Mock Canvas server ------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, base: string) => void;
let server: Server;
let base = "";
let handler: Handler = (_req, res) => res.end();
let requests: IncomingMessage[] = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push(req);
    handler(req, res, base);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  requests = [];
});

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const config = () => ({ ok: true as const, config: { baseUrl: base, token: FAKE_TOKEN } });
const fast = { retryDelayMs: 1, timeoutMs: 500 };

function pagedCourses(pages: unknown[][]): Handler {
  return (req, res, origin) => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/api/v1/users/self") return json(res, 200, { id: "42", name: "Ana López", short_name: "Ana" });
    const page = Number(url.searchParams.get("page") ?? "1");
    const next = page < pages.length ? `<${origin}/api/v1/courses?page=${page + 1}&per_page=2>; rel="next", ` : "";
    json(res, 200, pages[page - 1] ?? [], { link: `${next}<${origin}/api/v1/courses?page=1&per_page=2>; rel="first"` });
  };
}

describe("Canvas client against a mock server", () => {
  it("authenticates with the Bearer token and follows every page", async () => {
    handler = pagedCourses([
      [{ id: "1", name: "A", workflow_state: "available" }, { id: "2", name: "B", workflow_state: "available" }],
      [{ id: "3", name: "C", workflow_state: "available" }, { id: "4", name: "D", workflow_state: "completed" }],
      [{ id: "5", name: "E", workflow_state: "available" }],
    ]);
    const overview = await readCanvasOverview(config(), fast);
    assert.equal(overview.state, "connected");
    assert.ok(overview.state === "connected");
    assert.deepEqual(overview.profile, { id: "42", name: "Ana López", shortName: "Ana" });
    assert.deepEqual(overview.courses.map((c) => c.id), ["1", "2", "3", "5"]);
    assert.equal(overview.truncated, false);

    assert.equal(requests.length, 4); // profile + 3 course pages
    for (const req of requests) assert.equal(req.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    const first = new URL(requests[1].url ?? "", base);
    assert.equal(first.searchParams.get("per_page"), "100");
    assert.equal(first.searchParams.get("enrollment_state"), "active");
    assert.deepEqual(first.searchParams.getAll("include[]"), ["term"]);
  });

  it("stops on a repeated next link instead of looping forever", async () => {
    handler = (req, res, origin) => {
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/api/v1/users/self") return json(res, 200, { id: "1", name: "Ana" });
      json(res, 200, [{ id: "1", name: "A" }], { link: `<${origin}/api/v1/courses?page=2>; rel="next"` });
    };
    const overview = await readCanvasOverview(config(), fast);
    assert.ok(overview.state === "connected");
    assert.equal(requests.length, 3); // profile, page 1, page 2 (whose next repeats itself)
  });

  it("caps the number of pages and reports truncation", async () => {
    handler = (req, res, origin) => {
      const page = Number(new URL(req.url ?? "/", origin).searchParams.get("page") ?? "1");
      json(res, 200, [{ id: String(page), name: `C${page}` }], { link: `<${origin}/api/v1/courses?page=${page + 1}>; rel="next"` });
    };
    const result = await createCanvasClient(config().config, { ...fast, maxPages: 3 }).getAllPages("courses");
    assert.equal(result.items.length, 3);
    assert.equal(result.truncated, true);
  });

  it("refuses to follow a pagination link to another origin (the token would leak)", async () => {
    handler = (req, res, origin) => {
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/api/v1/users/self") return json(res, 200, { id: "1", name: "Ana" });
      json(res, 200, [{ id: "1", name: "A" }], { link: '<https://evil.example.com/api/v1/courses?page=2>; rel="next"' });
    };
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "invalid-response", status: null });
    assert.equal(requests.length, 2);
  });

  it("classifies 401, 403 and redirects without following them", async () => {
    handler = (_req, res) => json(res, 401, { errors: [{ message: "Invalid access token." }] });
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "unauthorized", status: 401 });

    handler = (_req, res) => json(res, 403, { status: "unauthorized" });
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "forbidden", status: 403 });

    requests = [];
    handler = (_req, res) => {
      res.writeHead(302, { location: `${base}/login` });
      res.end();
    };
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "redirected", status: 302 });
    assert.equal(requests.length, 1);
  });

  it("retries a transient 503 once, then reports unavailable", async () => {
    handler = (_req, res) => json(res, 503, {});
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "unavailable", status: 503 });
    assert.equal(requests.length, 2);

    requests = [];
    let calls = 0;
    handler = (req, res, origin) => {
      calls += 1;
      if (calls === 1) return json(res, 502, {});
      pagedCourses([[{ id: "1", name: "A" }]])(req, res, origin);
    };
    const overview = await readCanvasOverview(config(), fast);
    assert.equal(overview.state, "connected");
  });

  it("times out a hanging Canvas and reports unavailable", async () => {
    handler = () => {
      /* never responds */
    };
    const started = Date.now();
    assert.deepEqual(await readCanvasOverview(config(), { retryDelayMs: 1, timeoutMs: 150 }), { state: "error", kind: "unavailable", status: null });
    assert.ok(Date.now() - started < 2000);
  });

  it("reports network failures as unavailable", async () => {
    const closed = { ok: true as const, config: { baseUrl: "http://127.0.0.1:1", token: FAKE_TOKEN } };
    assert.deepEqual(await readCanvasOverview(closed, fast), { state: "error", kind: "unavailable", status: null });
  });

  it("survives HTML, invalid JSON and unexpected shapes", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>Login</html>");
    };
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "invalid-response", status: 200 });

    handler = (_req, res) => json(res, 200, ["not", "a", "profile"]);
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "invalid-response", status: null });

    handler = (req, res, origin) => {
      if (new URL(req.url ?? "/", origin).pathname === "/api/v1/users/self") return json(res, 200, { id: "1", name: "Ana" });
      json(res, 200, { courses: "not an array" });
    };
    assert.deepEqual(await readCanvasOverview(config(), fast), { state: "error", kind: "invalid-response", status: null });
  });

  it("accepts Canvas's while(1); JSON prefix", async () => {
    handler = (req, res, origin) => {
      if (new URL(req.url ?? "/", origin).pathname === "/api/v1/users/self") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('while(1);{"id":"1","name":"Ana"}');
      }
      json(res, 200, []);
    };
    const overview = await readCanvasOverview(config(), fast);
    assert.ok(overview.state === "connected" && overview.profile.name === "Ana");
  });

  it("never puts the token in what the page renders, even when Canvas echoes it", async () => {
    handler = (_req, res) => json(res, 401, { errors: [{ message: `Invalid token ${FAKE_TOKEN}` }] });
    const failed = await readCanvasOverview(config(), fast);
    assert.ok(!JSON.stringify(failed).includes(FAKE_TOKEN));

    handler = pagedCourses([[{ id: "1", name: `Curso ${FAKE_TOKEN}`.slice(0, 5), description: FAKE_TOKEN }]]);
    const ok = await readCanvasOverview(config(), fast);
    assert.ok(!JSON.stringify(ok).includes(FAKE_TOKEN));

    assert.deepEqual(await readCanvasOverview({ ok: false, problem: "missing" }), { state: "not-configured", problem: "missing" });
  });
});
