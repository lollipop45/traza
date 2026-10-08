// Manual check of TRAZA's scheduler endpoint (POST /api/internal/scheduler). Never prints the secret.
//
//   node scripts/scheduler-check.mjs                    → http://localhost:3000, rejection checks only
//   node scripts/scheduler-check.mjs --run              → also two REAL authorized runs (see below)
//   node scripts/scheduler-check.mjs --base https://<production-domain> [--run]
//
// SCHEDULER_SECRET is read from the environment, or else from .env.local. The real secret is only
// ever sent in the Authorization header; the rejection checks use random fake values.
//
// --run performs the real work, exactly like Supabase Cron would: reminders that are due ARE sent,
// and Canvas / Google sync if their cooldowns allow it. The second run shows that nothing repeats.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = (baseIndex >= 0 ? args[baseIndex + 1] : "http://localhost:3000").replace(/\/+$/, "");
const run = args.includes("--run");
const endpoint = `${base}/api/internal/scheduler`;

function readSecret() {
  if (process.env.SCHEDULER_SECRET) return process.env.SCHEDULER_SECRET.trim();
  if (!existsSync(".env.local")) return null;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = /^\s*SCHEDULER_SECRET\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return null;
}

async function post(label, url, init = {}) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { method: "POST", ...init });
  } catch {
    console.log(`${label}: no response (is the server running at ${base}?)`);
    process.exitCode = 1;
    return null;
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = `(${text.length} bytes, not JSON)`;
  }
  console.log(`${label}: HTTP ${response.status} in ${Date.now() - started} ms`);
  return { status: response.status, body };
}

function expect(result, status) {
  if (!result) return;
  const ok = result.status === status;
  console.log(`  ${ok ? "OK" : "UNEXPECTED"}: expected ${status}`);
  if (!ok) process.exitCode = 1;
}

const secret = readSecret();
if (!secret || secret.length < 32) {
  console.log("SCHEDULER_SECRET is missing or shorter than 32 characters (environment or .env.local).");
  process.exit(1);
}
const fake = () => randomBytes(32).toString("base64url");

console.log(`Scheduler endpoint: ${endpoint}`);
expect(await post("1. no Authorization header", endpoint), 401);
expect(await post("2. wrong secret", endpoint, { headers: { Authorization: `Bearer ${fake()}` } }), 401);
expect(await post("3. secret in the query string only", `${endpoint}?secret=${fake()}`), 401);
expect(await post("4. secret in the body only", endpoint, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: fake() }) }), 401);
expect(await post("5. GET is not accepted", endpoint, { method: "GET" }), 405);

if (!run) {
  console.log("\nAuthorized run skipped. Add --run to run the scheduler for real (it may send due reminders and sync Canvas / Google).");
} else {
  for (const label of ["6. authorized run", "7. authorized run again (nothing should repeat)"]) {
    const result = await post(label, endpoint, { headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: "{}" });
    if (result) console.log(JSON.stringify(result.body, null, 2));
    expect(result, 200);
  }
}
