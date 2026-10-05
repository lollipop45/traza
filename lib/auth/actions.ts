"use server";

import { redirect } from "next/navigation";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/routes";
import { createClient } from "@/lib/supabase/server";

export type SignInState = {
  error: string | null;
  /** Echoed back so the email field survives a failed attempt. Never the password. */
  email: string;
};

// One message for every failure (unknown email, wrong password, unconfirmed account, rate limit,
// network): it must not reveal whether an account exists.
const SIGN_IN_FAILED = "No hemos podido iniciar sesión. Revisa tus datos.";

export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Introduce tu correo electrónico y tu contraseña.", email };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // Intentionally not logged: errors can carry the submitted email.
  if (error) return { error: SIGN_IN_FAILED, email };

  redirect(HOME_PATH);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  // "local" revokes this device's session (its refresh token) server-side and clears the cookies,
  // without signing the user out on their other devices.
  await supabase.auth.signOut({ scope: "local" });
  redirect(LOGIN_PATH);
}
