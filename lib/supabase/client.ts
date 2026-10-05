import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

/**
 * Supabase client for Client Components. Prefer the server client; use this only when data must be
 * fetched or mutated from the browser (e.g. realtime, optimistic UI). Only the publishable key is
 * used here; secret / service-role keys must never be imported into client code.
 */
export function createClient() {
  const { url, publishableKey } = getSupabaseEnv();
  return createBrowserClient(url, publishableKey);
}
