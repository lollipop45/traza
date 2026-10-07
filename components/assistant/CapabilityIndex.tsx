import { itemTypeIcons } from "@/components/ui/itemTypeIcons";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { actionTypeLabels } from "@/lib/assistant/labels";
import type { ProposedActionType } from "@/lib/assistant/types";

const capabilities: { type: ProposedActionType; description: string }[] = [
  { type: "task", description: "Pendientes con fecha y proyecto." },
  { type: "event", description: "Clases, entregas y citas." },
  { type: "note", description: "Apuntes y referencias para el Inbox." },
  { type: "idea", description: "Ideas sueltas para el Inbox." },
];

/** What the assistant can prepare, and the rule that nothing is created without confirmation. */
export function CapabilityIndex() {
  return (
    <section aria-labelledby="capabilities-heading">
      <SectionHeader index="02" title="Puede preparar" id="capabilities-heading" />
      <ul className="divide-y divide-charcoal/10 border-b border-charcoal/10">
        {capabilities.map(({ type, description }) => {
          const Icon = itemTypeIcons[type];
          return (
            <li key={type} className="grid grid-cols-[1.25rem_1fr] gap-x-3.5 py-3.5">
              <Icon aria-hidden className="mt-px size-[18px] text-charcoal/70" strokeWidth={1.25} />
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.14em]">{actionTypeLabels[type]}</p>
                <p className="mt-1 text-[13px] text-graphite">{description}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-[13px] leading-[1.55] text-graphite">
        Responde con tus tareas, proyectos, eventos e Inbox reales. No edita ni borra nada, ni sincroniza Campus o Google.
      </p>
      <p className="mt-4 flex items-baseline gap-2.5 font-mono text-[10px] uppercase leading-[1.6] tracking-[0.14em] text-graphite">
        <span aria-hidden className="size-[5px] shrink-0 translate-y-[-1px] rounded-full bg-sage" />
        Nada se crea sin tu confirmación.
      </p>
    </section>
  );
}
