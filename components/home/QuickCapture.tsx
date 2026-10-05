"use client";

// Client Component only for the pending state, the inline error, the options disclosure and
// resetting after a save. The task is validated and inserted by the `createTask` Server Action.
import { Mic, Plus } from "lucide-react";
import { useActionState, useState } from "react";
import { DueDateField, PriorityField } from "@/components/tasks/TaskFields";
import { Button } from "@/components/ui/Button";
import { ComposerBar } from "@/components/ui/ComposerBar";
import { IconButton } from "@/components/ui/IconButton";
import type { ISODate } from "@/lib/calendar/types";
import { createTask, type CreateTaskState } from "@/lib/tasks/actions";
import { DEFAULT_TASK_PRIORITY, TASK_TITLE_MAX_LENGTH } from "@/lib/tasks/types";

const initialState: CreateTaskState = { error: null, title: "", created: 0 };
const OPTIONS_ID = "capture-options";

/** Enter creates a task with the defaults; "+" reveals optional date and priority. */
export function QuickCapture({ today }: { today: ISODate }) {
  const [state, formAction, pending] = useActionState(createTask, initialState);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [handledCreates, setHandledCreates] = useState(0);

  // After each successful create, close the options (adjusting state during render, not in an effect).
  if (state.created !== handledCreates) {
    setHandledCreates(state.created);
    setOptionsOpen(false);
  }

  return (
    <form action={formAction} aria-busy={pending}>
      <ComposerBar
        label="Nueva tarea"
        placeholder="¿Qué necesitas recordar?"
        name="title"
        maxLength={TASK_TITLE_MAX_LENGTH}
        defaultValue={state.title}
        describedBy={state.error ? "capture-error" : undefined}
        leading={
          <IconButton
            label={optionsOpen ? "Ocultar opciones de la tarea" : "Opciones de la tarea"}
            icon={Plus}
            iconClassName={`size-5 transition-transform ${optionsOpen ? "rotate-45" : ""}`}
            expanded={optionsOpen}
            controls={OPTIONS_ID}
            onClick={() => setOptionsOpen((open) => !open)}
          />
        }
        trailing={<IconButton label="Captura por voz" icon={Mic} iconClassName="size-[18px]" />}
      />

      {/* Always rendered so its defaults (no date, normal priority) are submitted with Enter.
          Keyed by the create count so the choices reset after each saved task. */}
      <div
        key={state.created}
        id={OPTIONS_ID}
        hidden={!optionsOpen}
        className="mt-3 flex flex-col gap-4 border-y border-charcoal/10 py-4"
      >
        <DueDateField idPrefix="capture" today={today} initial={null} />
        <PriorityField idPrefix="capture" initial={DEFAULT_TASK_PRIORITY} />
        <div>
          <Button variant="primary" type="submit" disabled={pending}>
            Añadir tarea
          </Button>
        </div>
      </div>

      {state.error && (
        <p id="capture-error" role="alert" className="mt-3 border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {state.error}
        </p>
      )}
    </form>
  );
}
