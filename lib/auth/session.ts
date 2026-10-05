import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { LOGIN_PATH } from "@/lib/auth/routes";
import { createClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email?: string;
};

/**
 * The signed-in user, from verified JWT claims (`getClaims()`), or null.
 * `getSession()` is deliberately not used: cookie contents alone are not proof of identity.
 * Memoised per request, so the layout guard and data queries share one verification.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined };
});

/** Server-side guard for private pages and Server Actions; redirects to /login without a session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(LOGIN_PATH);
  return user;
}
