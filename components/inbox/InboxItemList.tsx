import { FileText, Lightbulb, SquareCheck, type LucideIcon } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { ISODate } from "@/lib/calendar/types";
import { formatInboxDate, inboxTypeLabels } from "@/lib/inbox/items";
import type { InboxItem, InboxItemType } from "@/lib/inbox/types";

const typeIcons: Record<InboxItemType, LucideIcon> = {
  task: SquareCheck,
  idea: Lightbulb,
  note: FileText,
};

type InboxItemListProps = {
  items: InboxItem[];
  today: ISODate;
};

export function InboxItemList({ items, today }: InboxItemListProps) {
  return (
    <section aria-labelledby="recent-heading">
      <SectionHeader
        index="01"
        title="Elementos recientes"
        id="recent-heading"
        meta={String(items.length).padStart(2, "0")}
      />
      {items.length > 0 ? (
        <ul className="divide-y divide-charcoal/10">
          {items.map((item) => (
            <InboxRow key={item.id} item={item} today={today} />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-[14px] text-graphite">No hay elementos de este tipo.</p>
      )}
    </section>
  );
}

function InboxRow({ item, today }: { item: InboxItem; today: ISODate }) {
  const Icon = typeIcons[item.type];
  const isIdea = item.type === "idea";
  const dateLabel = formatInboxDate(item, today);

  return (
    <li className="relative isolate grid grid-cols-[1.25rem_1fr] items-start gap-x-3.5 py-3.5 lg:py-4">
      {/* Ideas get a faint paper wash and a sage icon: the only colour in the list. The wash
          bleeds slightly past the text column while the dividers stay aligned. */}
      {isIdea && <span aria-hidden className="absolute inset-y-0 -inset-x-3 -z-10 bg-paper/70" />}
      <Icon
        aria-hidden
        className={`mt-0.5 size-[18px] ${isIdea ? "text-sage" : "text-charcoal/70"}`}
        strokeWidth={isIdea ? 1.6 : 1.25}
      />

      <div className="min-w-0">
        <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em]">{item.title}</p>
        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
              dateLabel === "Hoy" ? "text-charcoal" : "text-graphite"
            }`}
          >
            {inboxTypeLabels[item.type]} · {dateLabel}
          </span>
          {item.project && <span className="text-[13px] text-graphite">{item.project}</span>}
        </p>
      </div>
    </li>
  );
}
