import { SectionHeader } from "@/components/ui/SectionHeader";
import type { ProjectWithCounts } from "@/lib/projects/types";
import { ProjectItem } from "./ProjectItem";

export type ProjectIndexEntry = {
  project: ProjectWithCounts;
  number: number;
};

type ProjectIndexProps = {
  /** null when the projects could not be loaded. */
  entries: ProjectIndexEntry[] | null;
  /** The user has projects, but none matches the active filter. */
  filtered: boolean;
  areas: string[];
};

export function ProjectIndex({ entries, filtered, areas }: ProjectIndexProps) {
  return (
    <section aria-labelledby="projects-heading">
      <SectionHeader
        index="01"
        title="Índice de proyectos"
        id="projects-heading"
        meta={entries === null ? "—" : String(entries.length).padStart(2, "0")}
      />
      {entries === null ? (
        <p role="alert" className="py-6 text-[14px] text-graphite">
          No se han podido cargar los proyectos.
        </p>
      ) : entries.length > 0 ? (
        <ol className="divide-y divide-charcoal/10 border-b border-charcoal/10">
          {entries.map((entry) => (
            <ProjectItem key={entry.project.id} {...entry} areas={areas} />
          ))}
        </ol>
      ) : (
        <p className="py-6 text-[14px] text-graphite">
          {filtered ? "No hay proyectos en este estado." : "Aún no hay proyectos. Crea el primero con +."}
        </p>
      )}
    </section>
  );
}
