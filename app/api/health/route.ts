import { NextResponse } from "next/server";

// Public liveness check for the deployment: the app is up and serving. Deliberately nothing else:
// no database, no configuration state, no integration state, no version, no external call.

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
