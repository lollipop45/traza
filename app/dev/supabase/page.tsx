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
  "signed-out-blocked": {
    ok: true,
    title: "Sin sesión · acceso bloqueado por seguridad",
    body: "La tabla existe y la base de datos deniega el acceso anónimo. Inicia sesión en /login para comprobar el acceso autenticado.",
  },
  "signed-out-readable": {
    ok: false,
    title: "Alerta · acceso anónimo abierto",
    body: "La consulta funcionó sin sesión. Revisa los privilegios de anon en public.tasks: no deberían existir.",
  },
  "signed-in-blocked": {
    ok: false,
    title: "Sesión válida · faltan privilegios",
    body: "El usuario está autenticado, pero no puede leer tasks. Aplica la migración de privilegios (docs/supabase.md).",
  },
  "signed-in-readable": {
    ok: true,
    title: "Sesión válida · acceso seguro a tasks",
    body: "El usuario autenticado consulta public.tasks a través de RLS. foreignRows debe ser 0: solo se ven sus propias tareas.",
  },
};

export default async function SupabaseDevPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const result = await checkSupabase();
  const verdict = verdicts[result.state];
  // Any visible row owned by someone else means RLS is broken.
  const ok = verdict.ok && !("foreignRows" in result && result.foreignRows > 0);
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
            <dd className={key === "state" ? (ok ? "text-charcoal" : "text-charcoal underline") : ""}>
              {String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
