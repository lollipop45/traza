"use client";

// Client Component only for the pending state, the inline error and clearing the field.
// The task is validated and inserted by the `createTask` Server Action.
import { Mic, Plus } from "lucide-react";
import { useActionState } from "react";
import { ComposerBar } from "@/components/ui/ComposerBar";
import { IconButton } from "@/components/ui/IconButton";
import { createTask, type CreateTaskState } from "@/lib/tasks/actions";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/tasks/types";

const initialState: CreateTaskState = { error: null, title: "" };

export function QuickCapture() {
  const [state, formAction, pending] = useActionState(createTask, initialState);

  return (
    <form action={formAction} aria-busy={pending}>
      <ComposerBar
        label="Nueva tarea"
        placeholder="¿Qué necesitas recordar?"
        name="title"
        maxLength={TASK_TITLE_MAX_LENGTH}
        defaultValue={state.title}
        describedBy={state.error ? "capture-error" : undefined}
        leading={<IconButton type="submit" label="Añadir tarea" icon={Plus} disabled={pending} />}
        trailing={<IconButton label="Captura por voz" icon={Mic} iconClassName="size-[18px]" />}
      />
      {state.error && (
        <p id="capture-error" role="alert" className="mt-3 border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {state.error}
        </p>
      )}
    </form>
  );
}
