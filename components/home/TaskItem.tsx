"use client";

// Client Component only so the checkbox responds instantly (optimistic) and can show an error.
// The source of truth is the database: `setTaskCompleted` persists, then Home is revalidated.
import { Check } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { setTaskCompleted } from "@/lib/tasks/actions";
import type { DueLabel } from "@/lib/tasks/format";

type TaskItemProps = {
  id: string;
  title: string;
  done: boolean;
  due: DueLabel | null;
};

export function TaskItem({ id, title, done, due }: TaskItemProps) {
  // Falls back to the server value automatically if the update fails.
  const [optimisticDone, setOptimisticDone] = useOptimistic(done);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const errorId = `task-${id}-error`;

  function toggle(next: boolean) {
    setError(null);
    startTransition(async () => {
      setOptimisticDone(next);
      const result = await setTaskCompleted(id, next);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <li>
      <label className="group flex cursor-pointer items-start gap-3.5 py-3.5 lg:py-4">
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
            {title}
          </span>
          {error && (
            <span id={errorId} role="alert" className="mt-1 block text-[13px] text-charcoal">
              {error}
            </span>
          )}
        </span>

        {due && (
          <span
            className={`pt-[3px] font-mono text-[11px] uppercase tracking-[0.12em] ${
              due.urgent && !optimisticDone ? "text-charcoal" : "text-graphite"
            }`}
          >
            {due.text}
          </span>
        )}
      </label>
    </li>
  );
}
