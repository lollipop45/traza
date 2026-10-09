// Both variables are public by design (NEXT_PUBLIC_*): the publishable key is safe in the browser
// because Row Level Security, not the key, decides what data is reachable. They are read with
// literal `process.env.NAME` access, as Next.js requires for NEXT_PUBLIC_ variables.

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
