import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { CanvasAutoSyncStatus } from "@/components/canvas/CanvasAutoSyncStatus";
import { CanvasCourseRow } from "@/components/canvas/CanvasCourseRow";
import { AssignmentPreferenceRow } from "@/components/canvas/AssignmentPreferenceRow";
import { CanvasSyncPanel } from "@/components/canvas/CanvasSyncPanel";
import { AppShell } from "@/components/layout/AppShell";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { OutlineIconButton } from "@/components/ui/OutlineIconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { requireUser } from "@/lib/auth/session";
import { currentISODate } from "@/lib/calendar/dates";
import { getCanvasCourseLinks } from "@/lib/canvas/links";
import { buildCourseMapping, proposedProjectName, type CanvasCourseLink } from "@/lib/canvas/mapping";
import { getCanvasOverview } from "@/lib/canvas/queries";
import { getCanvasSyncStatus } from "@/lib/canvas/sync-state-store";
import { getCanvasAssignmentPreferences } from "@/lib/canvas/sync-store";
import type { CanvasOverview } from "@/lib/canvas/read";
import type { CanvasCourse } from "@/lib/canvas/types";
import { getProjectOptions } from "@/lib/projects/queries";
import type { ProjectOption } from "@/lib/projects/types";

export const metadata: Metadata = {
  title: "Campus · Proyectos · TRAZA",
};

function courseMeta(course: CanvasCourse): string {
  return ["Canvas", `ID ${course.id}`, course.courseCode, course.term?.name].filter(Boolean).join(" · ");
}

function snapshotMeta(link: CanvasCourseLink): string {
  return ["Canvas", `ID ${link.canvas_course_id}`, link.canvas_course_code].filter(Boolean).join(" · ");
}

function unavailableMessage(overview: Exclude<CanvasOverview, { state: "connected" }>): string {
  if (overview.state === "not-configured") return "Canvas no está configurado.";
  if (overview.kind === "unauthorized") return "No se ha podido autenticar con Campus Virtual.";
  return "Campus Virtual no está disponible en este momento.";
}

export default async function CanvasMappingPage() {
  const user = await requireUser();
  // Live Canvas courses (server-side, server-only token) + stored decisions + real projects.
  const [overview, linkResult, projectResult, preferences, syncView] = await Promise.all([
    getCanvasOverview(),
    getCanvasCourseLinks(),
    getProjectOptions(),
    // Stored per-assignment decisions; restoring needs no Canvas call, so they show even when Campus is down.
    getCanvasAssignmentPreferences(),
    // Automatic sync status (no Canvas call).
    getCanvasSyncStatus(user.id),
  ]);
  const projects = projectResult.ok ? projectResult.projects : [];
  const links = linkResult.ok ? linkResult.links : [];
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const mapping = overview.state === "connected" ? buildCourseMapping(overview.courses, links, projects) : null;

  return (
    <AppShell activeHref="/projects">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="lg:col-span-7">
          <PageHeader
            title="Campus"
            subtitle="Elige qué cursos de Campus Virtual sigue TRAZA."
            date={currentISODate()}
            action={<OutlineIconButton label="Volver a Proyectos" icon={ArrowLeft} href="/projects" />}
          />
        </div>


        <div className="flex flex-col gap-12 lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <CanvasAutoSyncStatus view={syncView} />

          {!linkResult.ok && (
            <p role="alert" className="border-l border-charcoal pl-3 text-[14px] text-charcoal">
              No se han podido cargar tus vínculos con Campus.
            </p>
          )}

          {overview.state !== "connected" ? (
            <Unavailable overview={overview} links={links} projects={projectsById} />
          ) : (
            mapping && (
            <>
              <CanvasSyncPanel linkedCount={mapping.linked.length} />

              <Section index="01" title="Sin vincular" count={mapping.unmapped.length} empty="Todos los cursos tienen una decisión.">
                {mapping.unmapped.map(({ course, suggestion }, i) => (
                  <CanvasCourseRow
                    key={course.id}
                    number={i + 1}
                    courseId={course.id}
                    name={course.name ?? `Curso ${course.id}`}
                    meta={courseMeta(course)}
                    state="unmapped"
                    linkedProject={null}
                    suggestion={suggestion}
                    proposedName={proposedProjectName(course)}
                    projects={projects}
                  />
                ))}
              </Section>

              <Section index="02" title="Vinculados" count={mapping.linked.length} empty="Aún no hay cursos vinculados.">
                {mapping.linked.map(({ course, project }, i) => (
                  <CanvasCourseRow
                    key={course.id}
                    number={i + 1}
                    courseId={course.id}
                    name={course.name ?? `Curso ${course.id}`}
                    meta={courseMeta(course)}
                    state="linked"
                    linkedProject={project}
                    suggestion={null}
                    proposedName={proposedProjectName(course)}
                    projects={projects}
                  />
                ))}
              </Section>

              {mapping.ignored.length > 0 && (
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-baseline justify-between border-b border-charcoal/10 pb-3 font-mono text-[11px] uppercase tracking-[0.14em] outline-none focus-visible:text-charcoal">
                    <span>
                      <span className="mr-3 text-graphite">03</span>Ignorados
                    </span>
                    <span className="text-graphite">
                      <span className="group-open:hidden">Mostrar</span>
                      <span className="hidden group-open:inline">Ocultar</span> · {String(mapping.ignored.length).padStart(2, "0")}
                    </span>
                  </summary>
                  <ol className="divide-y divide-charcoal/10">
                    {mapping.ignored.map(({ course }, i) => (
                      <CanvasCourseRow
                        key={course.id}
                        number={i + 1}
                        courseId={course.id}
                        name={course.name ?? `Curso ${course.id}`}
                        meta={courseMeta(course)}
                        state="ignored"
                        linkedProject={null}
                        suggestion={null}
                        proposedName={proposedProjectName(course)}
                        projects={projects}
                      />
                    ))}
                  </ol>
                </details>
              )}

              {mapping.missing.length > 0 && (
                <Section index="04" title="Fuera de Campus" count={mapping.missing.length} empty="">
                  {mapping.missing.map((link, i) => (
                    <CanvasCourseRow
                      key={link.id}
                      number={i + 1}
                      courseId={link.canvas_course_id}
                      name={link.canvas_course_name ?? `Curso ${link.canvas_course_id}`}
                      meta={snapshotMeta(link)}
                      state="missing"
                      linkedProject={link.project_id ? (projectsById.get(link.project_id) ?? null) : null}
                      suggestion={null}
                      proposedName=""
                      projects={projects}
                    />
                  ))}
                </Section>
              )}
            </>
            )
          )}

          {preferences && preferences.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-baseline justify-between border-b border-charcoal/10 pb-3 font-mono text-[11px] uppercase tracking-[0.14em] outline-none focus-visible:text-charcoal">
                <span>
                  <span className="mr-3 text-graphite">05</span>Entregas decididas por ti
                </span>
                <span className="text-graphite">
                  <span className="group-open:hidden">Mostrar</span>
                  <span className="hidden group-open:inline">Ocultar</span> · {String(preferences.length).padStart(2, "0")}
                </span>
              </summary>
              <ol className="divide-y divide-charcoal/10">
                {preferences.map((preference, i) => (
                  <AssignmentPreferenceRow
                    key={preference.id}
                    number={i + 1}
                    preferenceId={preference.id}
                    name={preference.canvas_assignment_name ?? "Entrega de Campus"}
                    state={preference.state === "included" ? "included" : "ignored"}
                  />
                ))}
              </ol>
            </details>
          )}
        </div>

        <aside className="lg:col-span-4 lg:col-start-9 lg:row-start-2">
          <SectionHeader index="00" title="Cómo funciona" id="how-heading" />
          <p className="pt-4 text-[14px] leading-[1.55] text-graphite">
            Cada curso se identifica por su ID de Canvas, no por su nombre. Vincúlalo a un proyecto, crea uno nuevo desde el
            curso o ignóralo. Nada se vincula automáticamente.
          </p>
          <p className="mt-3 text-[14px] leading-[1.55] text-graphite">
            Al sincronizar, solo se importan como tareas las entregas con una acción real (subir un archivo, un texto,
            un cuestionario, un foro, una entrega presencial con fecha…) de los cursos vinculados. Las columnas de notas
            y la asistencia se omiten; lo dudoso queda en «Revisar» hasta que decidas. Campus decide el título, la fecha
            y el proyecto; tú, la prioridad y si está hecha. Nada se borra solo: «Ignorar en TRAZA» quita una tarea de
            Campus y evita que vuelva.
          </p>
          <p className="mt-3 text-[14px] leading-[1.55] text-graphite">
            Mientras usas TRAZA, Campus se comprueba solo como mucho cada 30 minutos, con las mismas reglas: lo dudoso
            nunca se importa sin tu decisión. «Sincronizar Campus» sigue disponible para hacerlo al momento.
          </p>
          {mapping && (
            <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
              {mapping.unmapped.length} sin vincular · {mapping.linked.length} vinculados · {mapping.ignored.length} ignorados
            </p>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

function Section({ index, title, count, empty, children }: { index: string; title: string; count: number; empty: string; children: ReactNode }) {
  const id = `canvas-${index}-heading`;
  return (
    <section aria-labelledby={id}>
      <SectionHeader index={index} title={title} id={id} meta={String(count).padStart(2, "0")} />
      {count > 0 ? <ol className="divide-y divide-charcoal/10">{children}</ol> : <p className="py-6 text-[14px] text-graphite">{empty}</p>}
    </section>
  );
}

/** Campus down or not configured: say so, and keep showing the stored decisions untouched. */
function Unavailable({
  overview,
  links,
  projects,
}: {
  overview: Exclude<CanvasOverview, { state: "connected" }>;
  links: CanvasCourseLink[];
  projects: Map<string, ProjectOption>;
}) {
  return (
    <>
      <p role="status" className="border-l border-charcoal pl-3 text-[15px] leading-[1.5] text-charcoal">
        {unavailableMessage(overview)}
        <span className="mt-1 block text-[14px] text-graphite">Tus vínculos guardados se conservan. Inténtalo de nuevo más tarde.</span>
      </p>
      {links.length > 0 && (
        <section aria-labelledby="saved-heading">
          <SectionHeader index="01" title="Decisiones guardadas" id="saved-heading" meta={String(links.length).padStart(2, "0")} />
          <ol className="divide-y divide-charcoal/10">
            {links.map((link, i) => (
              <li key={link.id} className="grid grid-cols-[2.25rem_1fr] gap-x-2 py-4">
                <span aria-hidden className="pt-[3px] font-mono text-[11px] tracking-[0.12em] text-graphite">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em] break-words">
                    {link.canvas_course_name ?? `Curso ${link.canvas_course_id}`}
                  </p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
                    {link.state === "linked"
                      ? `Vinculado · ${(link.project_id && projects.get(link.project_id)?.name) || "Proyecto"}`
                      : "Ignorado"}{" "}
                    · ID {link.canvas_course_id}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
