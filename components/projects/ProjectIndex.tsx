import { SectionHeader } from "@/components/ui/SectionHeader";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { Project } from "@/lib/projects/types";
import { ProjectEntry } from "./ProjectEntry";

export type ProjectIndexEntry = {
  project: Project;
  number: number;
  milestone?: CalendarEvent;
};

export function ProjectIndex({ entries }: { entries: ProjectIndexEntry[] }) {
  return (
    <section aria-labelledby="projects-heading">
      <SectionHeader
        index="01"
        title="Índice de proyectos"
        id="projects-heading"
        meta={String(entries.length).padStart(2, "0")}
      />
      {entries.length > 0 ? (
        <ol className="divide-y divide-charcoal/10 border-b border-charcoal/10">
          {entries.map((entry) => (
            <ProjectEntry key={entry.project.id} {...entry} />
          ))}
        </ol>
      ) : (
        <p className="py-6 text-[14px] text-graphite">No hay proyectos en este estado.</p>
      )}
    </section>
  );
}
