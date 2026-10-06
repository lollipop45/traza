"use client";

// One Canvas course and the user's decision about it. Every write goes through a Server Action that
// re-reads the course from Canvas on the server; this component only sends the course id and the
// user's choice (a project, or a new project's fields). Nothing here is ever saved automatically.
import { Check } from "lucide-react";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { ProjectFields } from "@/components/projects/ProjectFields";
import { Button } from "@/components/ui/Button";
import {
  clearCanvasCourseDecision,
  createProjectFromCanvasCourse,
  ignoreCanvasCourse,
  linkCanvasCourse,
} from "@/lib/canvas/actions";
import type { DecisionResult } from "@/lib/canvas/decisions";
import { projectChoices } from "@/lib/projects/projects";
import type { ProjectOption } from "@/lib/projects/types";

export type CourseRowState = "unmapped" | "linked" | "ignored" | "missing";

type CanvasCourseRowProps = {
  number: number;
  courseId: string;
  /** Display name: from Canvas now, or the stored snapshot for courses no longer listed. */
  name: string;
  meta: string;
  state: CourseRowState;
  /** The linked project, when state is "linked". */
  linkedProject: ProjectOption | null;
  /** A conservative name match, shown as a hint only (unmapped courses). */
  suggestion: ProjectOption | null;
  /** Prefill for "Crear proyecto". */
  proposedName: string;
  /** All of the user's projects; narrowed to assignable ones (+ the current link). */
  projects: ProjectOption[];
};

const STATUS_LABELS: Record<CourseRowState, string> = {
  unmapped: "Sin vincular",
  linked: "Vinculado",
  ignored: "Ignorado",
  missing: "No visible en Campus",
};

const selectClass =
  "h-9 w-full max-w-sm rounded-md border border-charcoal/15 bg-paper px-2.5 text-[14px] text-charcoal outline-none focus:border-charcoal/40";

export function CanvasCourseRow(props: CanvasCourseRowProps) {
  const { number, courseId, name, meta, state, linkedProject, suggestion, proposedName, projects } = props;
  const [mode, setMode] = useState<"idle" | "link" | "create">("idle");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const prefix = `course-${courseId}`;

  function run(action: () => Promise<DecisionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) setMode("idle");
      else setError(result.error);
    });
  }

  // onSubmit rather than form actions, so a failed attempt keeps the user's input.
  function submit(event: FormEvent<HTMLFormElement>, action: (formData: FormData) => Promise<DecisionResult>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    run(() => action(formData));
  }

  const choices = projectChoices(projects, linkedProject?.id ?? null);
  const defaultProject = linkedProject?.id ?? suggestion?.id ?? "";

  return (
    <li className="grid grid-cols-[2.25rem_1fr] gap-x-2 py-5" aria-busy={pending}>
      <span aria-hidden className="pt-[3px] font-mono text-[11px] tracking-[0.12em] text-graphite">
        {String(number).padStart(2, "0")}
      </span>

      <div className="min-w-0">
        <p className={`text-[15px] leading-[22px] font-medium tracking-[-0.01em] break-words ${state === "ignored" ? "text-charcoal/60" : ""}`}>
          {name}
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] break-words text-graphite">{meta}</p>

        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className={`font-mono text-[10px] uppercase tracking-[0.14em] ${state === "linked" ? "text-charcoal" : "text-graphite"}`}>
            {STATUS_LABELS[state]}
          </span>
          {state === "linked" && <span className="text-charcoal">{linkedProject?.name ?? "Proyecto no disponible"}</span>}
          {state === "unmapped" && suggestion && (
            <span className="text-graphite">
              Coincidencia sugerida: <span className="text-charcoal">{suggestion.name}</span>
            </span>
          )}
        </p>

        {mode === "link" && (
          <Panel onSubmit={(event) => submit(event, (formData) => linkCanvasCourse(courseId, formData))} label="Vincular a proyecto">
            <label htmlFor={`${prefix}-project`} className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
              Proyecto
            </label>
            {choices.length > 0 ? (
              <select id={`${prefix}-project`} name="project_id" required defaultValue={defaultProject} className={selectClass}>
                <option value="" disabled>
                  Elige un proyecto
                </option>
                {choices.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.status === "archived" ? `${project.name} · Archivado` : project.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[13px] text-graphite">No hay proyectos en curso o planificados. Crea uno desde este curso.</p>
            )}
            <PanelButtons pending={pending} submitLabel="Vincular" onCancel={() => setMode("idle")} disabled={choices.length === 0} />
          </Panel>
        )}

        {mode === "create" && (
          <Panel onSubmit={(event) => submit(event, (formData) => createProjectFromCanvasCourse(courseId, formData))} label="Crear proyecto desde el curso">
            <ProjectFields
              idPrefix={`${prefix}-new`}
              initial={{ name: proposedName, area: null, description: null, status: "active" }}
              statuses={["active", "planned"]}
              areas={[]}
            />
            <PanelButtons pending={pending} submitLabel="Crear y vincular" onCancel={() => setMode("idle")} />
          </Panel>
        )}

        {error && (
          <p role="alert" className="mt-3 border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
            {error}
          </p>
        )}

        {mode === "idle" && (
          <div className="mt-3 flex flex-wrap gap-2">
            {state === "unmapped" && (
              <>
                <Button variant="secondary" onClick={() => setMode("link")} disabled={pending}>
                  Vincular
                </Button>
                <Button variant="secondary" onClick={() => setMode("create")} disabled={pending}>
                  Crear proyecto
                </Button>
                <Button variant="secondary" onClick={() => run(() => ignoreCanvasCourse(courseId))} disabled={pending}>
                  Ignorar
                </Button>
              </>
            )}
            {state === "linked" && (
              <>
                <Button variant="secondary" onClick={() => setMode("link")} disabled={pending}>
                  Cambiar proyecto
                </Button>
                <Button variant="secondary" onClick={() => run(() => clearCanvasCourseDecision(courseId))} disabled={pending}>
                  Desvincular
                </Button>
                <Button variant="secondary" onClick={() => run(() => ignoreCanvasCourse(courseId))} disabled={pending}>
                  Ignorar
                </Button>
              </>
            )}
            {state === "ignored" && (
              <Button variant="secondary" onClick={() => run(() => clearCanvasCourseDecision(courseId))} disabled={pending}>
                Restaurar
              </Button>
            )}
            {state === "missing" && (
              <Button variant="secondary" onClick={() => run(() => clearCanvasCourseDecision(courseId))} disabled={pending}>
                Quitar decisión
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Panel({ onSubmit, label, children }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; label: string; children: ReactNode }) {
  return (
    <form onSubmit={onSubmit} aria-label={label} className="mt-4 flex flex-col gap-3 border-y border-charcoal/10 py-4">
      {children}
    </form>
  );
}

function PanelButtons({ pending, submitLabel, onCancel, disabled }: { pending: boolean; submitLabel: string; onCancel: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Button variant="primary" type="submit" disabled={pending || disabled} icon={Check}>
        {submitLabel}
      </Button>
      <Button variant="secondary" onClick={onCancel} disabled={pending}>
        Cancelar
      </Button>
    </div>
  );
}
