// TEMPORARY development-only route. Delete the whole app/dev/ folder once real task data is wired.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { checkSupabase, type SupabaseCheck } from "./check";

export const metadata: Metadata = {
  title: "Supabase · dev",
  robots: { index: false, follow: false },
};

const verdicts: Record<SupabaseCheck["state"], { ok: boolean; title: string; body: string }> = {
  "missing-config": {
    ok: false,
    title: "Configuración ausente",
    body: "Faltan las variables NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY en .env.local.",
  },
  unreachable: {
    ok: false,
    title: "Sin conexión con Supabase",
    body: "No se pudo contactar con el proyecto o la clave fue rechazada. Revisa la URL, la clave publicable y la red.",
  },
  "schema-missing": {
    ok: true,
    title: "Conexión correcta · migración pendiente",
    body: "Supabase responde, pero la tabla public.tasks aún no existe. Aplica la migración (docs/supabase.md).",
  },
  "access-blocked": {
    ok: true,
    title: "Conexión correcta · acceso bloqueado por seguridad",
    body: "La tabla existe y los privilegios/RLS deniegan el acceso sin sesión. Es el comportamiento esperado hasta la fase de autenticación.",
  },
  readable: {
    ok: true,
    title: "Conexión correcta · lectura permitida",
    body: "La consulta se ejecutó; RLS limita las filas a las del usuario autenticado.",
  },
};

export default async function SupabaseDevPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const result = await checkSupabase();
  const verdict = verdicts[result.state];
  const details = Object.entries(result).filter(([key]) => key !== "state");

  return (
    <main className="mx-auto max-w-[560px] px-5 py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">Dev · Supabase</p>
      <h1 className="mt-4 text-[32px] leading-tight font-light tracking-[-0.03em]">{verdict.title}</h1>
      <p className="mt-3 text-[15px] leading-[1.55] text-graphite">{verdict.body}</p>

      <dl className="mt-8 border-t border-charcoal/10 font-mono text-[12px]">
        {[["state", result.state], ...details].map(([key, value]) => (
          <div key={key} className="flex justify-between border-b border-charcoal/10 py-2.5">
            <dt className="uppercase tracking-[0.14em] text-graphite">{key}</dt>
            <dd className={key === "state" ? (verdict.ok ? "text-charcoal" : "text-charcoal underline") : ""}>
              {String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
