import type { ReactNode } from "react";
import { formatDayMonth } from "@/lib/calendar/dates";
import { projectStatusLabel } from "@/lib/projects/projects";
import type { ProjectWithCounts } from "@/lib/projects/types";
import { ProgressLine } from "./ProgressLine";

const statusClass: Record<string, string> = {
  active: "text-charcoal",
  planned: "text-graphite",
  archived: "text-graphite/70",
};

type ProjectEntryProps = {
  project: ProjectWithCounts;
  /** Position in the full index (display order), stable across filters. Never stored. */
  number: number;
  /** Row-level control in the top-right corner (the edit button). */
  action: ReactNode;
};

export function ProjectEntry({ project, number, action }: ProjectEntryProps) {
  const isArchived = project.status === "archived";
  const headingId = `project-${project.id}`;

  return (
    <article aria-labelledby={headingId} className="grid grid-cols-[2.25rem_1fr] gap-x-2 py-6 lg:py-7">
      <span aria-hidden className="pt-[6px] font-mono text-[11px] tracking-[0.12em] text-graphite">
        {String(number).padStart(2, "0")}
      </span>

      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <h3
            id={headingId}
            className={`min-w-0 text-[19px] leading-[26px] font-medium tracking-[-0.015em] break-words ${
              isArchived ? "text-charcoal/70" : ""
            }`}
          >
            {project.name}
          </h3>
          {action}
        </div>

        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] break-words">
          {project.area && (
            <>
              <span className="text-graphite">{project.area}</span>
              <span aria-hidden className="px-2 text-graphite/50">
                /
              </span>
            </>
          )}
          <span className={statusClass[project.status] ?? "text-graphite"}>{projectStatusLabel(project.status)}</span>
          {project.campusLinked && (
            <>
              <span aria-hidden className="px-2 text-graphite/50">
                /
              </span>
              <span className="text-graphite" title="Vinculado a un curso de Campus Virtual">
                Campus
              </span>
            </>
          )}
        </p>

        {project.description && (
          <p className="mt-3 max-w-[52ch] text-[14px] leading-[1.55] break-words whitespace-pre-line text-graphite">
            {project.description}
          </p>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-[1.2fr_0.8fr_1.2fr]">
          <Fact term="Avance" className="col-span-2 lg:col-span-1">
            <ProgressLine value={project.progress} label={`Avance de ${project.name}`} />
          </Fact>

          <Fact term="Tareas">
            {project.pendingTaskCount} {project.pendingTaskCount === 1 ? "pendiente" : "pendientes"}
            <span className="text-graphite"> / {project.taskCount}</span>
          </Fact>

          <Fact term="Próximo hito">
            {/* Derived on read: earliest pending task due date or calendar event, today or later. */}
            {project.nextMilestone ? (
              <>
                <span className="font-mono text-[11px] uppercase tracking-[0.12em]">{formatDayMonth(project.nextMilestone.date)}</span>
                <span className="mt-0.5 block break-words text-graphite">{project.nextMilestone.title}</span>
              </>
            ) : (
              <span className="text-graphite">Sin hito próximo</span>
            )}
          </Fact>
        </dl>
      </div>
    </article>
  );
}

function Fact({ term, className = "", children }: { term: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">{term}</dt>
      <dd className="mt-1.5 text-[14px] leading-[1.4]">{children}</dd>
    </div>
  );
}
