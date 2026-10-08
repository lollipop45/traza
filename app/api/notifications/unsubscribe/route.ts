import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { PUSH_HEADER, readSmallJson } from "@/lib/notifications/request";
import { deleteSubscriptionByEndpoint } from "@/lib/notifications/store";
import { MAX_SUBSCRIPTION_BODY_BYTES, parseEndpoint } from "@/lib/notifications/subscription";
import { isSameOriginRequest } from "@/lib/security/same-origin";

// Removes THIS device's subscription ("Desactivar en este dispositivo"): the caller's own row with
// that endpoint only. Other devices of the user are untouched; another user's rows are unreachable
// (RLS + user filter). POST only, same-origin only, session required.

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request.headers, PUSH_HEADER)) return json({ ok: false }, 403);
  const user = await getSessionUser();
  if (!user) return json({ ok: false }, 401);

  const body = await readSmallJson(request, MAX_SUBSCRIPTION_BODY_BYTES);
  const endpoint = parseEndpoint(typeof body === "object" && body !== null ? (body as { endpoint?: unknown }).endpoint : null);
  if (!endpoint) return json({ ok: false }, 400);
  return (await deleteSubscriptionByEndpoint(user.id, endpoint)) ? json({ ok: true }) : json({ ok: false }, 500);
}
