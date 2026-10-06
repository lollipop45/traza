import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { NewProjectForm } from "@/components/projects/NewProjectForm";
import { ProjectIndex } from "@/components/projects/ProjectIndex";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { FilterIndex } from "@/components/ui/FilterIndex";
import { OutlineIconButton } from "@/components/ui/OutlineIconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { currentISODate } from "@/lib/calendar/dates";
import { distinctAreas, filterProjects, projectFilters, resolveProjectFilter } from "@/lib/projects/projects";
import { getProjectIndex } from "@/lib/projects/queries";

export const metadata: Metadata = {
  title: "Proyectos · TRAZA",
};

function projectsHref(estado: string | null, nuevo: boolean): string {
  const params = new URLSearchParams();
  if (estado) params.set("estado", estado);
  if (nuevo) params.set("nuevo", "1");
  const query = params.toString();
  return query ? `/projects?${query}` : "/projects";
}

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  const { estado, nuevo } = await searchParams;
  const activeFilter = resolveProjectFilter(estado);
  const creating = nuevo !== undefined;

  // Real data (public.projects + task counts derived from public.tasks), current user only.
  const result = await getProjectIndex();
  const projects = result.ok ? result.projects : null;
  const areas = projects ? distinctAreas(projects) : [];

  // The counts double as the status summary (04 en curso, 01 planificado, 01 archivado).
  const filterOptions = projectFilters.map((filter) => ({
    key: filter.label,
    label: filter.label,
    href: projectsHref(filter.slug, creating),
    count: projects ? filterProjects(projects, filter).length : 0,
  }));

  // Numbers are positions in the full index, so they stay the same under every filter.
  const entries = projects
    ? projects
        .map((project, i) => ({ project, number: i + 1 }))
        .filter((entry) => !activeFilter.status || entry.project.status === activeFilter.status)
    : null;

  return (
    <AppShell activeHref="/projects">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="flex flex-col gap-6 lg:col-span-7 lg:gap-8">
          <PageHeader
            title="Proyectos"
            subtitle="Organiza tu trabajo por áreas y procesos."
            date={currentISODate()}
            action={
              <div className="flex items-center gap-2">
                <Link
                  href="/projects/canvas"
                  className="inline-flex h-9 items-center rounded-md border border-charcoal/15 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-charcoal outline-none transition-colors hover:bg-paper focus-visible:border-charcoal/40 focus-visible:bg-paper"
                >
                  Campus
                </Link>
                <OutlineIconButton
                  label={creating ? "Cerrar nuevo proyecto" : "Nuevo proyecto"}
                  icon={Plus}
                  iconClassName={`size-[18px] transition-transform ${creating ? "rotate-45" : ""}`}
                  href={projectsHref(activeFilter.slug, !creating)}
                />
              </div>
            }
          />
          {creating && <NewProjectForm closeHref={projectsHref(activeFilter.slug, false)} areas={areas} />}
        </div>

        {/* A two-column index under the header on mobile; a status index beside the list on desktop. */}
        <div className="-mt-2 lg:col-span-4 lg:col-start-9 lg:row-start-2 lg:mt-0">
          <div className="hidden lg:block">
            <SectionHeader index="02" title="Estado" id="status-heading" />
          </div>
          <FilterIndex
            label="Filtrar por estado"
            options={filterOptions}
            activeKey={activeFilter.label}
            variant="grid"
          />
        </div>

        <div className="lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <ProjectIndex
            entries={entries}
            filtered={Boolean(projects && projects.length > 0 && activeFilter.status)}
            areas={areas}
          />
        </div>
      </div>
    </AppShell>
  );
}
