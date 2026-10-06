"use client";

// One stored per-assignment decision. "Restaurar" removes it: the assignment goes back to the
// automatic classification at the next preview/sync. It never creates or deletes a task by itself.
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { restoreCanvasAssignment } from "@/lib/canvas/assignment-actions";

type AssignmentPreferenceRowProps = {
  number: number;
  preferenceId: string;
  name: string;
  state: "ignored" | "included";
};

export function AssignmentPreferenceRow({ number, preferenceId, name, state }: AssignmentPreferenceRowProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function restore() {
    setError(null);
    startTransition(async () => {
      const result = await restoreCanvasAssignment(preferenceId);
      // On success the revalidated page no longer lists this row.
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <li className="grid grid-cols-[2.25rem_1fr] gap-x-2 py-4" aria-busy={pending}>
      <span aria-hidden className="pt-[3px] font-mono text-[11px] tracking-[0.12em] text-graphite">
        {String(number).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] leading-[22px] tracking-[-0.01em] break-words">{name}</p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          {state === "ignored" ? "Ignorada por ti · no se importa" : "Importada por ti · aunque requería revisión"}
        </p>
        <div className="mt-3">
          <Button variant="secondary" onClick={restore} disabled={pending}>
            {state === "ignored" ? "Restaurar" : "Quitar decisión"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}
