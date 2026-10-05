// Both variables are public by design (NEXT_PUBLIC_*): the publishable key is safe in the browser
// because Row Level Security, not the key, decides what data is reachable. They must be read with
// literal `process.env.NAME` access so Next.js can inline them into the browser bundle.

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}

export function getSupabaseEnv(): { url: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    // Never include the values themselves in errors or logs.
    throw new Error(
      "Supabase no está configurado: faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (ver docs/supabase.md).",
    );
  }
  return { url, publishableKey };
}
