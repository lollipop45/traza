import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DeadlineMark } from "@/components/ui/DeadlineMark";
import { formatDayMonth } from "@/lib/calendar/dates";
import type { CalendarEvent } from "@/lib/calendar/types";
import { projectAreaLabels, projectStatusLabels } from "@/lib/projects/projects";
import type { Project, ProjectStatus } from "@/lib/projects/types";
import { ProgressLine } from "./ProgressLine";

const statusClass: Record<ProjectStatus, string> = {
  active: "text-charcoal",
  planned: "text-graphite",
  archived: "text-graphite/70",
};

type ProjectEntryProps = {
  project: Project;
  /** Position in the full index, stable across filters. */
  number: number;
  milestone?: CalendarEvent;
};

export function ProjectEntry({ project, number, milestone }: ProjectEntryProps) {
  const isArchived = project.status === "archived";
  const headingId = `project-${project.id}`;

  return (
    <li>
      <article aria-labelledby={headingId} className="grid grid-cols-[2.25rem_1fr] gap-x-2 py-6 lg:py-7">
        <span aria-hidden className="pt-[6px] font-mono text-[11px] tracking-[0.12em] text-graphite">
          {String(number).padStart(2, "0")}
        </span>

        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <h3
              id={headingId}
              className={`text-[19px] leading-[26px] font-medium tracking-[-0.015em] ${
                isArchived ? "text-charcoal/70" : ""
              }`}
            >
              {project.name}
            </h3>
            {/* Hint of the future detail view; rows are not interactive yet. */}
            <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-graphite/50" strokeWidth={1.25} />
          </div>

          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em]">
            <span className="text-graphite">{projectAreaLabels[project.area]}</span>
            <span aria-hidden className="px-2 text-graphite/50">
              /
            </span>
            <span className={statusClass[project.status]}>{projectStatusLabels[project.status]}</span>
          </p>

          <p className="mt-3 max-w-[52ch] text-[14px] leading-[1.55] text-graphite">{project.description}</p>

          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-[1.2fr_0.8fr_1.2fr]">
            <Fact term="Avance" className="col-span-2 lg:col-span-1">
              <ProgressLine value={project.progress} label={`Avance de ${project.name}`} />
            </Fact>

            <Fact term="Tareas">
              {project.pendingTaskCount} {project.pendingTaskCount === 1 ? "pendiente" : "pendientes"}
              <span className="text-graphite"> / {project.taskCount}</span>
            </Fact>

            <Fact term="Próximo hito">
              <Milestone event={milestone} isArchived={isArchived} />
            </Fact>
          </dl>
        </div>
      </article>
    </li>
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

function Milestone({ event, isArchived }: { event?: CalendarEvent; isArchived: boolean }) {
  if (!event) {
    return <span className="text-graphite">{isArchived ? "Completado" : "Sin fecha fija"}</span>;
  }
  // Same marks as the calendar: square for deadlines, dot for ordinary events.
  return (
    <>
      <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.12em]">
        {event.kind === "deadline" ? (
          <DeadlineMark />
        ) : (
          <span aria-hidden className="size-1 rounded-full bg-graphite" />
        )}
        <time dateTime={event.date}>{formatDayMonth(event.date)}</time>
      </span>
      <span className="mt-0.5 block">{event.title}</span>
    </>
  );
}
