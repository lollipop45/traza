"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setTaskCompleted } from "@/lib/tasks/actions";
import { isDone, type HomeTask } from "@/lib/tasks/types";

/**
 * Optimistic completion toggle for a real task, shared by Home and Inbox rows. The database stays
 * the source of truth: `setTaskCompleted` persists and revalidates every task view; the optimistic
 * value falls back to the server's automatically if the update fails.
 */
export function useTaskCompletion(task: Pick<HomeTask, "id" | "status">) {
  const [done, setOptimisticDone] = useOptimistic(isDone(task));
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(next: boolean) {
    setError(null);
    startTransition(async () => {
      setOptimisticDone(next);
      const result = await setTaskCompleted(task.id, next);
      if (!result.ok) setError(result.error);
    });
  }

  return { done, toggle, error };
}
