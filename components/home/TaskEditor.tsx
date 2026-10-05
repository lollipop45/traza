"use client";

// Inline editor that replaces a task row in place. Only title, due date and priority are editable;
// deletion is a second, explicit step with its own confirmation.
import { Check, Trash2 } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { DueDateField, PriorityField } from "@/components/tasks/TaskFields";
import { Button } from "@/components/ui/Button";
import type { ISODate } from "@/lib/calendar/types";
import { deleteTask, updateTask } from "@/lib/tasks/actions";
import { TASK_TITLE_MAX_LENGTH, isTaskPriority, type HomeTask } from "@/lib/tasks/types";

type TaskEditorProps = {
  task: HomeTask;
  today: ISODate;
  onClose: () => void;
};

export function TaskEditor({ task, today, onClose }: TaskEditorProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const prefix = `edit-${task.id}`;

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
      const result = await deleteTask(task.id);
      // On success the revalidated list no longer contains this row, so nothing else to do.
      if (!result.ok) {
        setError(result.error);
        setConfirmingDelete(false);
      }
    });
  }

  return (
    <form onSubmit={save} aria-label={`Editar tarea: ${task.title}`} aria-busy={pending} className="flex flex-col gap-4 py-4">
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
      <PriorityField idPrefix={prefix} initial={isTaskPriority(task.priority) ? task.priority : "normal"} />

      {error && (
        <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}

      {confirmingDelete ? (
        <div role="group" aria-labelledby={`${prefix}-delete`} className="flex flex-col gap-3 border-t border-charcoal/10 pt-4">
          <p id={`${prefix}-delete`} className="text-[14px] leading-[1.5]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">Eliminar tarea</span>
            <span className="mt-1 block text-graphite">Esta acción no se puede deshacer.</span>
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
            Eliminar tarea
          </Button>
        </div>
      )}
    </form>
  );
}
