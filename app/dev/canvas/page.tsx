// Development-only, read-only Canvas diagnostic. Calls Canvas on the server with the server-only
// token and renders only projected fields (never the token, raw JSON or response bodies).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getCanvasOverview } from "@/lib/canvas/queries";
import type { CanvasOverview } from "@/lib/canvas/read";
import type { CanvasCourse } from "@/lib/canvas/types";

export const metadata: Metadata = {
  title: "Canvas · dev",
  robots: { index: false, follow: false },
};

type Verdict = { connection: string; title: string; body: string };

function verdictFor(overview: Exclude<CanvasOverview, { state: "connected" }>): Verdict {
  if (overview.state === "not-configured") {
    const body = {
      missing: "Añade CANVAS_BASE_URL y CANVAS_ACCESS_TOKEN a .env.local y reinicia el servidor (docs/supabase.md · Canvas).",
      "invalid-base-url": "CANVAS_BASE_URL no es válida: usa la dirección https del campus, sin credenciales, parámetros ni fragmentos.",
      "invalid-token": "CANVAS_ACCESS_TOKEN tiene un formato no válido (vacío, demasiado corto o con espacios).",
    }[overview.problem];
    return { connection: "No configurado", title: "Canvas no está configurado.", body };
  }
  const byKind: Record<typeof overview.kind, Omit<Verdict, "connection">> = {
    unauthorized: {
      title: "No se ha podido autenticar con Campus Virtual.",
      body: "El token no es válido, ha caducado o se ha revocado. Genera uno nuevo en Campus Virtual.",
    },
    forbidden: {
      title: "Campus Virtual ha denegado el acceso.",
      body: "El token es válido, pero no tiene permiso para leer tu perfil o tus cursos.",
    },
    unavailable: {
      title: "Campus Virtual no está disponible en este momento.",
      body: "No hubo respuesta a tiempo o el servidor falló. Inténtalo de nuevo más tarde.",
    },
    redirected: {
      title: "Campus Virtual ha respondido con una redirección.",
      body: "Revisa CANVAS_BASE_URL: debe ser la dirección https del campus, no una página de inicio de sesión.",
    },
    "invalid-response": {
      title: "Respuesta inesperada de Campus Virtual.",
      body: "La respuesta no tiene el formato esperado de la API de Canvas. Revisa CANVAS_BASE_URL.",
    },
  };
  return { connection: "Error", ...byKind[overview.kind] };
}

export default async function CanvasDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // /dev/* skips the proxy's redirect, so the TRAZA session is checked here.
  await requireUser();

  const overview = await getCanvasOverview();

  return (
    <main className="mx-auto max-w-[640px] px-5 py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">Dev · Canvas · solo lectura</p>

      {overview.state === "connected" ? (
        <Connected overview={overview} />
      ) : (
        <Failure overview={overview} />
      )}
    </main>
  );
}

function Failure({ overview }: { overview: Exclude<CanvasOverview, { state: "connected" }> }) {
  const verdict = verdictFor(overview);
  return (
    <>
      <h1 className="mt-4 text-[32px] leading-tight font-light tracking-[-0.03em]">{verdict.title}</h1>
      <p className="mt-3 text-[15px] leading-[1.55] text-graphite">{verdict.body}</p>
      <Facts
        rows={[
          ["Conexión", verdict.connection],
          ["Motivo", overview.state === "not-configured" ? overview.problem : overview.kind],
          ...(overview.state === "error" && overview.status ? [["HTTP", String(overview.status)] as [string, string]] : []),
        ]}
      />
    </>
  );
}

function Connected({ overview }: { overview: Extract<CanvasOverview, { state: "connected" }> }) {
  const { profile, courses } = overview;
  return (
    <>
      <h1 className="mt-4 text-[32px] leading-tight font-light tracking-[-0.03em]">Campus Virtual conectado</h1>
      <Facts
        rows={[
          ["Conexión", "Conectado"],
          ["Usuario", profile.shortName ?? profile.name],
          ["ID Canvas", profile.id],
          ["Cursos", `${courses.length} ${courses.length === 1 ? "curso activo" : "cursos activos"}`],
          ...(overview.restrictedCount > 0 ? [["Restringidos", `${overview.restrictedCount} con acceso limitado por fechas`] as [string, string]] : []),
          ...(overview.skippedCount > 0 ? [["Ilegibles", `${overview.skippedCount} omitidos`] as [string, string]] : []),
          ...(overview.truncated ? [["Aviso", "Lista truncada por el límite de páginas"] as [string, string]] : []),
        ]}
      />

      <section aria-labelledby="courses-heading" className="mt-12">
        <h2 id="courses-heading" className="flex items-baseline justify-between border-b border-charcoal/10 pb-2.5 font-mono text-[10px] uppercase tracking-[0.14em]">
          <span>Cursos activos</span>
          <span className="text-graphite">{String(courses.length).padStart(2, "0")}</span>
        </h2>
        {courses.length === 0 ? (
          <p className="py-6 text-[14px] text-graphite">No hay cursos con matrícula activa.</p>
        ) : (
          <ol className="divide-y divide-charcoal/10">
            {courses.map((course, i) => (
              <CourseRow key={course.id} course={course} number={i + 1} />
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function CourseRow({ course, number }: { course: CanvasCourse; number: number }) {
  const meta = [course.courseCode, `ID ${course.id}`, course.term?.name].filter(Boolean).join(" · ");
  return (
    <li className="grid grid-cols-[2.25rem_1fr] gap-x-2 py-4">
      <span aria-hidden className="pt-[3px] font-mono text-[11px] tracking-[0.12em] text-graphite">
        {String(number).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em] break-words">{course.name ?? "Curso sin nombre"}</p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] break-words text-graphite">{meta}</p>
      </div>
    </li>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-8 border-t border-charcoal/10 font-mono text-[12px]">
      {rows.map(([key, value]) => (
        <div key={key} className="flex justify-between gap-4 border-b border-charcoal/10 py-2.5">
          <dt className="uppercase tracking-[0.14em] text-graphite">{key}</dt>
          <dd className="min-w-0 text-right break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
