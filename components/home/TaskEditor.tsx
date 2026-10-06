"use client";

// Inline editor that replaces a task row in place. Only title, due date, priority and project are editable;
// deletion is a second, explicit step with its own confirmation. Tasks imported from Campus show
// their Canvas-managed fields (title, due date, project) read-only: only priority can change, and
// instead of a plain delete they offer "Ignorar en TRAZA" (the server enforces all of this).
import { Check, EyeOff, Trash2 } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { DueDateField, PriorityField, ProjectField } from "@/components/tasks/TaskFields";
import { Button } from "@/components/ui/Button";
import { formatShortDate } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { projectChoices } from "@/lib/projects/projects";
import type { ProjectOption } from "@/lib/projects/types";
import { ignoreCanvasTask } from "@/lib/canvas/assignment-actions";
import { deleteTask, updateTask } from "@/lib/tasks/actions";
import { TASK_TITLE_MAX_LENGTH, isCanvasTask, isTaskPriority, type HomeTask } from "@/lib/tasks/types";

type TaskEditorProps = {
  task: HomeTask;
  today: ISODate;
  /** All of the user's projects; narrowed here to assignable ones plus the current project. */
  projects: ProjectOption[];
  onClose: () => void;
};

export function TaskEditor({ task, today, projects, onClose }: TaskEditorProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const prefix = `edit-${task.id}`;
  const managed = isCanvasTask(task);

  // onSubmit rather than a form action: React resets form fields after an action, which would
  // discard the user's edits when saving fails.
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await updateTask(task.id, formData);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      // A Campus task is never deleted plainly (the next sync would recreate it): "Ignorar en TRAZA"
      // records the assignment as ignored and removes the task in one transaction.
      const result = managed ? await ignoreCanvasTask(task.id) : await deleteTask(task.id);
      // On success the revalidated list no longer contains this row, so nothing else to do.
      if (!result.ok) {
        setError(result.error);
        setConfirmingDelete(false);
      }
    });
  }

  return (
    <form onSubmit={save} aria-label={`Editar tarea: ${task.title}`} aria-busy={pending} className="flex flex-col gap-4 py-4">
      {managed ? (
        <CanvasManagedFields task={task} projects={projects} />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${prefix}-title`} className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
              Tarea
            </label>
            <input
              id={`${prefix}-title`}
              name="title"
              type="text"
              required
              autoFocus
              autoComplete="off"
              maxLength={TASK_TITLE_MAX_LENGTH}
              defaultValue={task.title}
              className="h-11 w-full rounded-md border border-charcoal/15 bg-paper px-3 text-[15px] text-charcoal outline-none focus:border-charcoal/40"
            />
          </div>
          <DueDateField idPrefix={prefix} today={today} initial={task.due_date} />
        </>
      )}

      <PriorityField idPrefix={prefix} initial={isTaskPriority(task.priority) ? task.priority : "normal"} />
      {!managed && <ProjectField idPrefix={prefix} projects={projectChoices(projects, task.project_id)} initial={task.project_id} />}

      {error && (
        <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}

      {confirmingDelete ? (
        <div role="group" aria-labelledby={`${prefix}-delete`} className="flex flex-col gap-3 border-t border-charcoal/10 pt-4">
          <p id={`${prefix}-delete`} className="text-[14px] leading-[1.5]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">{managed ? "Ignorar en TRAZA" : "Eliminar tarea"}</span>
            <span className="mt-1 block text-graphite">
              {managed
                ? "La tarea se quita y Campus no volverá a importarla. Puedes restaurarla en Proyectos › Campus."
                : "Esta acción no se puede deshacer."}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={remove} disabled={pending} icon={managed ? EyeOff : Trash2}>
              {managed ? "Ignorar" : "Eliminar"}
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
          <Button variant="secondary" onClick={() => setConfirmingDelete(true)} disabled={pending} icon={managed ? EyeOff : Trash2}>
            {managed ? "Ignorar en TRAZA" : "Eliminar tarea"}
          </Button>
        </div>
      )}
    </form>
  );
}

/** Read-only view of what Canvas owns; nothing here is submitted. */
function CanvasManagedFields({ task, projects }: { task: HomeTask; projects: ProjectOption[] }) {
  const projectName = task.project_id ? projects.find((project) => project.id === task.project_id)?.name : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">Campus · Datos sincronizados</p>
      <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em] break-words">{task.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
        <dt className="font-mono text-[10px] uppercase leading-[21px] tracking-[0.14em] text-graphite">Fecha</dt>
        <dd>{task.due_date ? formatShortDate(task.due_date) : "Sin fecha"}</dd>
        <dt className="font-mono text-[10px] uppercase leading-[21px] tracking-[0.14em] text-graphite">Proyecto</dt>
        <dd className="break-words">{projectName ?? "Sin proyecto"}</dd>
      </dl>
    </div>
  );
}
