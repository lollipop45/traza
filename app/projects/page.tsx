import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { ProjectIndex } from "@/components/projects/ProjectIndex";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { FilterIndex } from "@/components/ui/FilterIndex";
import { OutlineIconButton } from "@/components/ui/OutlineIconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { calendarEvents, projects, today } from "@/lib/mock-data";
import { filterProjects, findMilestone, projectFilters, resolveProjectFilter } from "@/lib/projects/projects";

export const metadata: Metadata = {
  title: "Proyectos · TRAZA",
};

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  const { estado } = await searchParams;
  const activeFilter = resolveProjectFilter(estado);

  // The counts double as the status summary (04 en curso, 01 planificado, 01 archivado).
  const filterOptions = projectFilters.map((filter) => ({
    key: filter.label,
    label: filter.label,
    href: filter.slug ? `/projects?estado=${filter.slug}` : "/projects",
    count: filterProjects(projects, filter).length,
  }));

  const visible = new Set(filterProjects(projects, activeFilter));
  const entries = projects
    .map((project, i) => ({ project, number: i + 1, milestone: findMilestone(project, calendarEvents) }))
    .filter((entry) => visible.has(entry.project));

  return (
    <AppShell activeHref="/projects">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="lg:col-span-7">
          <PageHeader
            title="Proyectos"
            subtitle="Organiza tu trabajo por áreas y procesos."
            date={today}
            action={<OutlineIconButton label="Nuevo proyecto" icon={Plus} />}
          />
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
          <ProjectIndex entries={entries} />
        </div>
      </div>
    </AppShell>
  );
}
