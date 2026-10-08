import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import manifest from "@/app/manifest";
import nextConfig from "@/next.config";
import { normalizeRedirectUri, readGoogleCalendarConfig } from "@/lib/google-calendar/env";

// Production readiness (Prompt 23): headers, development routes, health check, base-URL rules,
// PWA paths and repository hygiene. Static checks plus pure functions; no server, no network.

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, "");
function files(dir: string, accept: (file: string) => boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? files(full, accept) : accept(full) ? [full] : [];
  });
}
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function headerRules(): Promise<HeaderRule[]> {
  assert.ok(nextConfig.headers);
  return (await nextConfig.headers()) as HeaderRule[];
}

/** Headers for a path the way Next.js applies them: every matching rule, later rules win. */
async function headersFor(pathname: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const rule of await headerRules()) {
    const matches = rule.source === "/:path*" || rule.source === pathname;
    if (matches) for (const header of rule.headers) result.set(header.key.toLowerCase(), header.value);
  }
  return result;
}

describe("security headers", () => {
  it("every response: nosniff, referrer policy, no framing, no plugins/base hijack, minimal permissions", async () => {
    const headers = await headersFor("/calendar");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(headers.get("x-frame-options"), "DENY");
    assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(headers.get("content-security-policy") ?? "", /object-src 'none'/);
    assert.match(headers.get("permissions-policy") ?? "", /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
  });

  it("the global CSP restricts nothing Next.js, Supabase, Google OAuth or the PWA need", async () => {
    const csp = (await headersFor("/")).get("content-security-policy") ?? "";
    for (const directive of ["script-src", "connect-src", "default-src", "style-src", "img-src", "form-action", "worker-src", "manifest-src"]) {
      assert.ok(!csp.includes(directive), `${directive} would need nonces / allow-lists: deferred deliberately`);
    }
  });

  it("the service worker keeps its own headers (no-store, same-origin script) plus the framing rule", async () => {
    const headers = await headersFor("/sw.js");
    assert.equal(headers.get("cache-control"), "no-cache, no-store, must-revalidate");
    assert.match(headers.get("content-type") ?? "", /^application\/javascript/);
    const csp = headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'; script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    const rules = await headerRules();
    assert.ok(rules.findIndex((rule) => rule.source === "/sw.js") > rules.findIndex((rule) => rule.source === "/:path*"), "the specific rule must come later");
  });

  it("HSTS only on a Vercel production deployment (never on localhost)", async () => {
    assert.equal((await headersFor("/")).get("strict-transport-security"), undefined);
    assert.match(code("next.config.ts"), /process\.env\.VERCEL_ENV === "production" \? \[\{ key: "Strict-Transport-Security"/);
  });

  it("no high-frequency Vercel Cron: Supabase Cron is the scheduler", () => {
    if (!existsSync(path.join(ROOT, "vercel.json"))) return;
    assert.doesNotMatch(read("vercel.json"), /"crons"/);
  });
});

describe("development routes are unavailable in production", () => {
  it("every /dev page calls notFound() in production before doing anything", () => {
    const pages = files(path.join(ROOT, "app", "dev"), (f) => /page\.tsx$/.test(f));
    assert.ok(pages.length >= 2);
    for (const page of pages) {
      const source = code(rel(page));
      const guard = source.indexOf('if (process.env.NODE_ENV === "production") notFound();');
      assert.ok(guard > 0, rel(page));
      const body = source.slice(source.indexOf("export default"));
      assert.ok(body.indexOf("notFound()") < (body.indexOf("await ") === -1 ? Infinity : body.indexOf("await ")), `${rel(page)}: guard first`);
    }
  });

  it("no route outside app/dev is a development diagnostic", () => {
    for (const file of files(path.join(ROOT, "app"), (f) => /(page|route)\.tsx?$/.test(f))) {
      const name = rel(file);
      if (name.startsWith("app/dev/")) continue;
      assert.doesNotMatch(name, /\/(debug|diagnostics?|test)\//, name);
    }
  });

  it("development-only diagnostics are gated on NODE_ENV; the only production log is the scheduler summary", () => {
    /** console calls not inside (or on the line of) a diagnostics() check a few lines above. */
    const ungatedLogs = (file: string) => {
      const lines = code(file).split("\n");
      return lines.filter((line, i) => /console\.(info|warn|log|error)/.test(line) && !lines.slice(Math.max(0, i - 4), i + 1).some((l) => /diagnostics\(\)/.test(l)));
    };
    for (const file of ["app/api/integrations/canvas/auto-sync/route.ts", "app/api/integrations/google/auto-sync/route.ts", "app/api/notifications/check/route.ts", "lib/assistant/actions.ts", "lib/canvas/sync-actions.ts", "lib/google-calendar/sync-actions.ts"]) {
      assert.match(code(file), /process\.env\.NODE_ENV !== "production"/, file);
      assert.deepEqual(ungatedLogs(file), [], file);
    }
    const withProductionLogs = ["app", "lib"]
      .flatMap((dir) => files(path.join(ROOT, dir), (f) => /\.tsx?$/.test(f)))
      .map(rel)
      .filter((file) => ungatedLogs(file).length > 0);
    assert.deepEqual(withProductionLogs, ["app/api/internal/scheduler/route.ts"]);
  });
});

describe("health check", () => {
  it("GET /api/health returns only { ok: true }, uncached, and touches nothing else", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = GET();
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const source = code("app/api/health/route.ts");
    assert.deepEqual(source.match(/^import .*$/gm), ['import { NextResponse } from "next/server";']);
    assert.doesNotMatch(source, /process\.env|fetch\(|supabase/i);
  });
});

describe("production URLs", () => {
  it("Google OAuth: the callback comes only from GOOGLE_REDIRECT_URI; localhost is refused on Vercel production", () => {
    const base = {
      GOOGLE_CLIENT_ID: "123456789012-fakeclientid.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "GOCSPX-FAKE-client-secret-not-real",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
    };
    const local = "http://localhost:3000/api/integrations/google/callback";
    const production = "https://traza-example.vercel.app/api/integrations/google/callback";
    assert.equal(readGoogleCalendarConfig({ ...base, GOOGLE_REDIRECT_URI: local }).ok, true, "local development keeps working");
    assert.equal(readGoogleCalendarConfig({ ...base, GOOGLE_REDIRECT_URI: local, VERCEL_ENV: "preview" }).ok, true);
    for (const loopback of [local, "http://127.0.0.1:3000/api/integrations/google/callback", "https://localhost/api/integrations/google/callback"]) {
      assert.deepEqual(readGoogleCalendarConfig({ ...base, GOOGLE_REDIRECT_URI: loopback, VERCEL_ENV: "production" }), { ok: false, problem: "invalid-redirect-uri" });
    }
    const configured = readGoogleCalendarConfig({ ...base, GOOGLE_REDIRECT_URI: production, VERCEL_ENV: "production" });
    assert.ok(configured.ok && configured.config.redirectUri === production);
    for (const bad of ["http://traza-example.vercel.app/api/integrations/google/callback", "https://traza-example.vercel.app/other", "https://u:p@traza-example.vercel.app/api/integrations/google/callback", `${production}?x=1`]) {
      assert.equal(normalizeRedirectUri(bad), null, bad);
    }
  });

  it("the OAuth callback redirects back to the configured origin, never to the Host header", () => {
    const source = code("app/api/integrations/google/callback/route.ts");
    assert.match(source, /const origin = new URL\(configResult\.config\.redirectUri\)\.origin;/);
    assert.doesNotMatch(source, /x-forwarded-host|headers\.get\("host"\)/i);
  });

  it("no production code depends on localhost (loopback is only accepted, for development, by the URL validators)", () => {
    const allowed = new Set(["lib/canvas/env.ts", "lib/google-calendar/env.ts"]);
    for (const file of ["app", "lib", "components"].flatMap((dir) => files(path.join(ROOT, dir), (f) => /\.(ts|tsx)$/.test(f)))) {
      const name = rel(file);
      if (name.startsWith("app/dev/") || allowed.has(name)) continue;
      assert.doesNotMatch(code(name), /localhost|127\.0\.0\.1|http:\/\//, name);
    }
    assert.doesNotMatch(read("public/sw.js"), /localhost|127\.0\.0\.1|http:\/\//);
  });

  it("the PWA uses relative, same-origin URLs only (works on any HTTPS domain, no mixed content)", () => {
    const data = manifest();
    assert.equal(data.start_url, "/");
    assert.equal(data.scope, "/");
    for (const icon of data.icons ?? []) assert.match(icon.src, /^\/icons\/[a-z0-9-]+\.png$/);
    assert.match(code("components/pwa/PwaRegistrar.tsx"), /register\("\/sw\.js"/);
    assert.doesNotMatch(code("components/pwa/PwaRegistrar.tsx"), /scope:\s*"(?!\/")/);
  });
});

describe("repository hygiene", () => {
  it("env files, Vercel's local folder and key files are ignored", () => {
    const ignore = read(".gitignore");
    for (const rule of [".env*", ".vercel", "*.pem"]) assert.ok(ignore.split(/\r?\n/).includes(rule), rule);
  });

  it("no migration contains a secret, a production URL or a bearer token", () => {
    for (const file of files(path.join(ROOT, "supabase", "migrations"), (f) => f.endsWith(".sql"))) {
      const sql = readFileSync(file, "utf8");
      assert.doesNotMatch(sql, /sb_secret_|sb_publishable_|eyJhbGci|vercel\.app|Bearer [A-Za-z0-9]/, rel(file));
    }
  });
});
