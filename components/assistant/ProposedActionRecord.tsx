import type { ReactNode } from "react";
import { itemTypeIcons } from "@/components/ui/itemTypeIcons";
import { actionSourceLabels, actionTypeLabels } from "@/lib/assistant/labels";
import type { ActionView } from "@/lib/assistant/types";

type ProposedActionRecordProps = {
  action: ActionView;
  number: number;
  /** Per-record control (e.g. "Descartar"), shown under the fields. */
  children?: ReactNode;
};

const STATE_LABELS = { proposed: null, executed: "Creada", dismissed: "Descartada" } as const;

/** A proposed action laid out like a schedule entry: type, title, then labelled fields. */
export function ProposedActionRecord({ action, number, children }: ProposedActionRecordProps) {
  const Icon = itemTypeIcons[action.kind];
  const state = STATE_LABELS[action.state];
  return (
    <li className={`grid grid-cols-[1.25rem_1fr] gap-x-3.5 py-4 ${action.state === "dismissed" ? "opacity-60" : ""}`}>
      <Icon aria-hidden className="mt-px size-[18px] text-charcoal/70" strokeWidth={1.25} />
      <div className="min-w-0">
        <p className="flex items-baseline justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.14em]">
          <span className="text-charcoal">
            {actionTypeLabels[action.kind]}
            {state && <span className="text-graphite"> · {state}</span>}
          </span>
          <span aria-hidden className="text-graphite/70">
            {String(number).padStart(2, "0")}
          </span>
        </p>
        <p className={`mt-1 text-[16px] leading-[22px] font-medium tracking-[-0.01em] break-words ${action.state === "dismissed" ? "line-through" : ""}`}>{action.title}</p>

        <dl className="mt-3">
          {action.fields.map((field) => (
            <Field key={field.term} term={field.term}>
              {field.mono ? <span className="font-mono text-[13px] tabular-nums">{field.value}</span> : field.value}
            </Field>
          ))}
          <Field term="Origen">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="size-[5px] rounded-full bg-sage" />
              {actionSourceLabels.ai}
            </span>
          </Field>
        </dl>
        {children}
      </div>
    </li>
  );
}

function Field({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-baseline border-t border-charcoal/[0.07] py-1.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">{term}</dt>
      <dd className="text-[14px] break-words text-charcoal">{children}</dd>
    </div>
  );
}
