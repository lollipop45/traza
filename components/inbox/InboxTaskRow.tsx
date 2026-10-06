"use client";

// A real task in the Inbox feed: the same row of public.tasks that Home shows. Completion, editing
// and deletion go through the existing task actions (useTaskCompletion, TaskEditor); there is no
// Inbox-specific task state.
import { Check, PencilLine } from "lucide-react";
import { useRef, useState } from "react";
import { TaskEditor } from "@/components/home/TaskEditor";
import { CampusMark } from "@/components/tasks/CampusMark";
import { useTaskCompletion } from "@/components/tasks/useTaskCompletion";
import type { ISODate } from "@/lib/calendar/types";
import { entryDateLabel, inboxTypeLabels } from "@/lib/inbox/feed";
import type { InboxTaskEntry } from "@/lib/inbox/types";
import type { ProjectOption } from "@/lib/projects/types";
import { isCanvasTask } from "@/lib/tasks/types";

type InboxTaskRowProps = {
  entry: InboxTaskEntry;
  today: ISODate;
  projects: ProjectOption[];
};

export function InboxTaskRow({ entry, today, projects }: InboxTaskRowProps) {
  const { task } = entry;
  const { done, toggle, error } = useTaskCompletion(task);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const errorId = `inbox-task-${task.id}-error`;
  const date = entryDateLabel(entry, today);

  function closeEditor() {
    setEditing(false);
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
      <label className="group grid min-w-0 flex-1 cursor-pointer grid-cols-[1.25rem_1fr] items-start gap-x-3.5 py-3.5 lg:py-4">
        {/* The checkbox takes the place of the type icon: a task is the one kind you can complete. */}
        <span className="relative mt-0.5 grid size-[18px] place-items-center">
          <input
            type="checkbox"
            checked={done}
            onChange={(event) => toggle(event.target.checked)}
            aria-describedby={error ? errorId : undefined}
            className="peer absolute inset-0 cursor-pointer appearance-none rounded-full border border-charcoal/35 transition-colors checked:border-charcoal checked:bg-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
          />
          <Check aria-hidden className="pointer-events-none relative size-3 text-paper opacity-0 peer-checked:opacity-100" strokeWidth={2} />
        </span>

        <span className="min-w-0">
          <span className="block text-[15px] leading-[22px] font-medium tracking-[-0.01em] break-words transition-colors group-has-checked:text-graphite group-has-checked:line-through">
            {task.title}
          </span>
          <span className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span
              className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
                date.emphasis && !done ? "text-charcoal" : "text-graphite"
              }`}
            >
              {inboxTypeLabels.task} · {date.text}
            </span>
            {entry.projectName && <span className="text-[13px] text-graphite">{entry.projectName}</span>}
            {isCanvasTask(task) && (
              <span>
                <CampusMark separated={false} />
              </span>
            )}
          </span>
          {error && (
            <span id={errorId} role="alert" className="mt-1 block text-[13px] text-charcoal">
              {error}
            </span>
          )}
        </span>
      </label>

      <button
        ref={editButton}
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Editar tarea: ${task.title}`}
        title="Editar tarea"
        className="mt-2.5 grid size-8 shrink-0 place-items-center rounded-md text-graphite outline-none transition-colors hover:text-charcoal focus-visible:bg-paper focus-visible:text-charcoal lg:mt-3"
      >
        <PencilLine aria-hidden className="size-4" strokeWidth={1.25} />
      </button>
    </li>
  );
}
