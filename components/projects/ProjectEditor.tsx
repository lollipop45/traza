"use client";

// Inline editor that replaces a project entry in place. Name, area, description, status and
// progress are editable; archiving is choosing "Archivado". Deletion is a second, explicit step
// with its own confirmation, and never deletes tasks.
import { Check, Trash2 } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { deleteProject, updateProject } from "@/lib/projects/actions";
import { PROJECT_STATUSES, isProjectStatus, type ProjectWithCounts } from "@/lib/projects/types";
import { ProjectFields } from "./ProjectFields";

type ProjectEditorProps = {
  project: ProjectWithCounts;
  areas: string[];
  onClose: () => void;
};

export function ProjectEditor({ project, areas, onClose }: ProjectEditorProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const prefix = `edit-project-${project.id}`;

  // onSubmit rather than a form action: React resets form fields after an action, which would
  // discard the user's edits when saving fails.
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await updateProject(project.id, formData);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteProject(project.id);
      // On success the revalidated index no longer contains this project.
      if (!result.ok) {
        setError(result.error);
        setConfirmingDelete(false);
      }
    });
  }

  const { taskCount } = project;

  return (
    <form
      onSubmit={save}
      aria-label={`Editar proyecto: ${project.name}`}
      aria-busy={pending}
      className="flex flex-col gap-4 py-6 lg:py-7"
    >
      <ProjectFields
        idPrefix={prefix}
        initial={{
          name: project.name,
          area: project.area,
          description: project.description,
          status: isProjectStatus(project.status) ? project.status : "active",
          progress: project.progress,
        }}
        statuses={PROJECT_STATUSES}
        areas={areas}
      />

      {error && (
        <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}

      {confirmingDelete ? (
        <div role="group" aria-labelledby={`${prefix}-delete`} className="flex flex-col gap-3 border-t border-charcoal/10 pt-4">
          <p id={`${prefix}-delete`} className="text-[14px] leading-[1.5]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">Eliminar proyecto</span>
            <span className="mt-1 block text-graphite">Esta acción no se puede deshacer.</span>
            {taskCount > 0 && (
              <span className="mt-1 block text-charcoal">
                {taskCount === 1
                  ? "La tarea asociada se conservará sin proyecto."
                  : `Las ${taskCount} tareas asociadas se conservarán sin proyecto.`}
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={remove} disabled={pending} icon={Trash2}>
              Eliminar
            </Button>
            <Button variant="secondary" onClick={() => setConfirmingDelete(false)} disabled={pending} autoFocus>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-charcoal/10 pt-4">
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={pending} icon={Check}>
              Guardar
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
          </div>
          <Button variant="secondary" onClick={() => setConfirmingDelete(true)} disabled={pending} icon={Trash2}>
            Eliminar proyecto
          </Button>
        </div>
      )}
    </form>
  );
}
