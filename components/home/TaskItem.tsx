"use client";

// Client Component so the checkbox responds instantly (optimistic) and the row can switch to its
// inline editor. The database stays the source of truth: every change goes through a Server
// Action, then Home is revalidated.
import { Check, PencilLine } from "lucide-react";
import { useOptimistic, useRef, useState, useTransition } from "react";
import type { ISODate } from "@/lib/calendar/types";
import type { ProjectOption } from "@/lib/projects/types";
import { setTaskCompleted } from "@/lib/tasks/actions";
import { formatDueLabel } from "@/lib/tasks/format";
import { isDone, type HomeTask } from "@/lib/tasks/types";
import { TaskEditor } from "./TaskEditor";

const PRIORITY_MARKS: Partial<Record<string, { text: string; className: string }>> = {
  high: { text: "Prioridad alta", className: "text-charcoal" },
  low: { text: "Prioridad baja", className: "text-graphite" },
};

type TaskItemProps = {
  task: HomeTask;
  today: ISODate;
  /** All of the user's projects (names for display, choices for the editor). */
  projects: ProjectOption[];
};

export function TaskItem({ task, today, projects }: TaskItemProps) {
  // Falls back to the server value automatically if the update fails.
  const [optimisticDone, setOptimisticDone] = useOptimistic(isDone(task));
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);

  const errorId = `task-${task.id}-error`;
  const due = formatDueLabel(task.due_date, today);
  const priority = PRIORITY_MARKS[task.priority];
  const projectName = task.project_id ? projects.find((project) => project.id === task.project_id)?.name : undefined;

  function toggle(next: boolean) {
    setError(null);
    startTransition(async () => {
      setOptimisticDone(next);
      const result = await setTaskCompleted(task.id, next);
      if (!result.ok) setError(result.error);
    });
  }

  function closeEditor() {
    setEditing(false);
    // Return focus to the row's edit control once it is back in the DOM.
    requestAnimationFrame(() => editButton.current?.focus());
  }

  if (editing) {
    return (
      <li>
        <TaskEditor task={task} today={today} projects={projects} onClose={closeEditor} />
      </li>
    );
  }

  return (
    <li className="flex items-start gap-1">
      <label className="group flex min-w-0 flex-1 cursor-pointer items-start gap-3.5 py-3.5 lg:py-4">
        <span className="relative mt-px grid size-[18px] shrink-0 place-items-center">
          <input
            type="checkbox"
            checked={optimisticDone}
            onChange={(event) => toggle(event.target.checked)}
            aria-describedby={error ? errorId : undefined}
            className="peer absolute inset-0 cursor-pointer appearance-none rounded-full border border-charcoal/35 transition-colors checked:border-charcoal checked:bg-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
          />
          <Check
            aria-hidden
            className="pointer-events-none relative size-3 text-paper opacity-0 peer-checked:opacity-100"
            strokeWidth={2}
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium tracking-[-0.01em] break-words transition-colors group-has-checked:text-graphite group-has-checked:line-through">
            {task.title}
          </span>
          {projectName && (
            <span className="mt-1 block text-[13px] break-words text-graphite">{projectName}</span>
          )}
          {priority && (
            <span
              className={`mt-1 block font-mono text-[10px] uppercase tracking-[0.14em] group-has-checked:text-graphite/70 ${priority.className}`}
            >
              {priority.text}
            </span>
          )}
          {error && (
            <span id={errorId} role="alert" className="mt-1 block text-[13px] text-charcoal">
              {error}
            </span>
          )}
        </span>

        {due && (
          <span
            className={`shrink-0 pt-[3px] text-right font-mono text-[11px] uppercase tracking-[0.12em] ${
              due.urgent && !optimisticDone ? "text-charcoal" : "text-graphite"
            }`}
          >
            {due.text}
          </span>
        )}
      </label>

      <button
        ref={editButton}
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Editar tarea: ${task.title}`}
        title="Editar tarea"
        className="mt-2 grid size-8 shrink-0 place-items-center rounded-md text-graphite outline-none transition-colors hover:text-charcoal focus-visible:bg-paper focus-visible:text-charcoal lg:mt-2.5"
      >
        <PencilLine aria-hidden className="size-4" strokeWidth={1.25} />
      </button>
    </li>
  );
}
