"use client";

// Optional task fields shared by quick capture and the inline editor. They submit exactly the
// column names the server validates: `due_date` (YYYY-MM-DD or empty) and `priority`.
import { useState } from "react";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { addDays } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { PRIORITY_LABELS } from "@/lib/tasks/format";
import { TASK_PRIORITIES, type TaskPriority } from "@/lib/tasks/types";

type DueChoice = "none" | "today" | "tomorrow" | "custom";

const DUE_OPTIONS = [
  { value: "none", label: "Sin fecha" },
  { value: "today", label: "Hoy" },
  { value: "tomorrow", label: "Mañana" },
  { value: "custom", label: "Otra" },
] as const;

const PRIORITY_OPTIONS = TASK_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_LABELS[priority] }));

type DueDateFieldProps = {
  /** Prefix keeping element ids unique when several forms are on the page. */
  idPrefix: string;
  /** "Today" in the app time zone, provided by the server so no browser time zone is involved. */
  today: ISODate;
  initial: ISODate | null;
};

function initialChoice(initial: ISODate | null, today: ISODate): DueChoice {
  if (!initial) return "none";
  if (initial === today) return "today";
  if (initial === addDays(today, 1)) return "tomorrow";
  return "custom";
}

export function DueDateField({ idPrefix, today, initial }: DueDateFieldProps) {
  const [choice, setChoice] = useState<DueChoice>(() => initialChoice(initial, today));
  const [custom, setCustom] = useState<string>(initial ?? "");

  const dueDate =
    choice === "today" ? today : choice === "tomorrow" ? addDays(today, 1) : choice === "custom" ? custom : "";

  return (
    <div className="flex flex-col gap-2">
      <ChoiceGroup
        id={`${idPrefix}-due`}
        label="Fecha"
        name="due_choice"
        options={DUE_OPTIONS}
        value={choice}
        onChange={(value) => setChoice(value as DueChoice)}
      />
      {choice === "custom" && (
        <input
          type="date"
          aria-label="Fecha de la tarea"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          className="h-9 w-fit rounded-md border border-charcoal/15 bg-paper px-3 font-mono text-[13px] text-charcoal outline-none focus:border-charcoal/40"
        />
      )}
      <input type="hidden" name="due_date" value={dueDate} />
    </div>
  );
}

export function PriorityField({ idPrefix, initial }: { idPrefix: string; initial: TaskPriority }) {
  const [priority, setPriority] = useState<TaskPriority>(initial);
  return (
    <ChoiceGroup
      id={`${idPrefix}-priority`}
      label="Prioridad"
      name="priority"
      options={PRIORITY_OPTIONS}
      value={priority}
      onChange={(value) => setPriority(value as TaskPriority)}
    />
  );
}
