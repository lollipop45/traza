import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { PUSH_HEADER, readSmallJson } from "@/lib/notifications/request";
import { saveSubscription } from "@/lib/notifications/store";
import { MAX_SUBSCRIPTION_BODY_BYTES, parseSubscription } from "@/lib/notifications/subscription";
import { isSameOriginRequest } from "@/lib/security/same-origin";

// Stores THIS device's Web Push subscription for the SIGNED-IN user (called by Ajustes after the
// user enabled notifications, and by the service worker if the browser rotates the subscription).
// POST only, same-origin only, session required. The body may carry only the subscription (endpoint
// + keys, validated and length-bounded); a user id is never accepted: the database takes auth.uid().
// Nothing is logged and nothing about the subscription is returned.

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request.headers, PUSH_HEADER)) return json({ ok: false }, 403);
  const user = await getSessionUser();
  if (!user) return json({ ok: false }, 401);

  const body = await readSmallJson(request, MAX_SUBSCRIPTION_BODY_BYTES);
  const subscription = parseSubscription(typeof body === "object" && body !== null ? (body as { subscription?: unknown }).subscription : null);
  if (!subscription) return json({ ok: false }, 400);
  return (await saveSubscription(subscription)) ? json({ ok: true }) : json({ ok: false }, 500);
}
