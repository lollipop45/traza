import type { ReactNode } from "react";
import { itemTypeIcons } from "@/components/ui/itemTypeIcons";
import { actionSourceLabels, actionTypeLabels } from "@/lib/assistant/actions";
import type { ProposedAction } from "@/lib/assistant/types";
import { formatDayHeading } from "@/lib/calendar/dates";

type ProposedActionRecordProps = {
  action: ProposedAction;
  number: number;
  projectName?: string;
};

/** A proposed action laid out like a schedule entry: type, title, then labelled fields. */
export function ProposedActionRecord({ action, number, projectName }: ProposedActionRecordProps) {
  const Icon = itemTypeIcons[action.type];
  return (
    <li className="grid grid-cols-[1.25rem_1fr] gap-x-3.5 py-4">
      <Icon aria-hidden className="mt-px size-[18px] text-charcoal/70" strokeWidth={1.25} />
      <div className="min-w-0">
        <p className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em]">
          <span className="text-charcoal">{actionTypeLabels[action.type]}</span>
          <span aria-hidden className="text-graphite/70">
            {String(number).padStart(2, "0")}
          </span>
        </p>
        <p className="mt-1 text-[16px] leading-[22px] font-medium tracking-[-0.01em]">{action.title}</p>

        <dl className="mt-3">
          {action.date && <Field term="Fecha">{formatDayHeading(action.date)}</Field>}
          {action.startTime && (
            <Field term="Hora">
              <span className="font-mono text-[13px] tabular-nums">
                {action.startTime}
                {action.endTime && ` – ${action.endTime}`}
              </span>
            </Field>
          )}
          {action.location && <Field term="Lugar">{action.location}</Field>}
          {projectName && <Field term="Proyecto">{projectName}</Field>}
          <Field term="Origen">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="size-[5px] rounded-full bg-sage" />
              {actionSourceLabels[action.source]}
            </span>
          </Field>
        </dl>
      </div>
    </li>
  );
}

function Field({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-baseline border-t border-charcoal/[0.07] py-1.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">{term}</dt>
      <dd className="text-[14px] text-charcoal">{children}</dd>
    </div>
  );
}
