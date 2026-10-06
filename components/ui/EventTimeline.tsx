import { PencilLine } from "lucide-react";
import Link from "next/link";
import { GOOGLE_EVENT_SOURCE, type CalendarEventItem, type CalendarItem } from "@/lib/calendar/types";

type EventTimelineProps = {
  items: CalendarItem[];
  /** Marks the first item in sage as the next thing happening. */
  highlightFirst?: boolean;
  /** When given, event rows get an edit link (task deadlines are edited from Home). */
  editHref?: (item: CalendarEventItem) => string;
};

/** Secondary line: what the item is attached to. Tasks never get invented times or places. */
function details(item: CalendarItem): string {
  const parts =
    item.itemType === "event"
      ? [item.allDay ? "Todo el día" : item.endTime ? `Hasta ${item.endTime}` : null, item.location, item.projectName]
      : [item.projectName];
  return parts.filter(Boolean).join(" · ");
}

/** Hairline timeline with one node per item: round for events, square for task deadlines. */
export function EventTimeline({ items, highlightFirst = false, editHref }: EventTimelineProps) {
  return (
    <ol>
      {items.map((item, i) => {
        const isFirst = i === 0;
        const isLast = i === items.length - 1;
        const isDeadline = item.itemType === "task-deadline";
        const isDone = isDeadline && item.done;
        const isHighlighted = highlightFirst && isFirst && !isDone;
        const time = item.itemType === "event" ? item.startTime : null;
        const isGoogle = item.itemType === "event" && item.source === GOOGLE_EVENT_SOURCE;
        const secondary = details(item);
        return (
          <li key={`${item.itemType}-${item.id}`} className="grid grid-cols-[3.25rem_1.25rem_1fr]">
            <time
              dateTime={time ? `${item.date}T${time}` : item.date}
              className="pt-3.5 font-mono text-[13px] leading-[22px] tabular-nums text-charcoal lg:pt-4"
            >
              {time ?? "—"}
            </time>

            <div aria-hidden className="relative">
              <span
                className={`absolute left-1/2 w-px -translate-x-1/2 bg-charcoal/15 ${
                  isFirst ? "top-[25px] lg:top-[27px]" : "top-0"
                } ${isLast ? "h-[25px] lg:h-[27px]" : "bottom-0"}`}
              />
              <span
                className={`absolute top-[22px] left-1/2 size-[7px] lg:top-6 -translate-x-1/2 border ${
                  isDeadline ? "" : "rounded-full"
                } ${
                  isHighlighted
                    ? "border-sage bg-sage"
                    : isDone
                      ? "border-charcoal/50 bg-sand"
                      : isDeadline
                        ? "border-charcoal bg-charcoal"
                        : "border-charcoal/40 bg-sand"
                }`}
              />
            </div>

            <div className={`flex min-w-0 items-start gap-2 py-3.5 pl-2 lg:py-4 ${isLast ? "" : "border-b border-charcoal/10"}`}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2.5 text-[15px] leading-[22px] font-medium tracking-[-0.01em]">
                  <span className={`break-words ${isDone ? "text-graphite line-through" : ""}`}>{item.title}</span>
                  {isDeadline && (
                    <span className="font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-graphite">
                      {["Tarea", item.campus && "Campus", isDone && "Hecha"].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  {isGoogle && (
                    <span className="font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-graphite" title="Importado de Google Calendar">
                      <span aria-hidden className="pr-2 text-graphite/50">
                        /
                      </span>
                      Google
                    </span>
                  )}
                </p>
                {secondary && <p className="mt-1 text-[13px] break-words text-graphite">{secondary}</p>}
              </div>
              {editHref && item.itemType === "event" && (
                <Link
                  href={editHref(item)}
                  scroll={false}
                  aria-label={`${isGoogle ? "Ver evento de Google" : "Editar evento"}: ${item.title}`}
                  title={isGoogle ? "Ver evento de Google" : "Editar evento"}
                  className="-mt-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-graphite outline-none transition-colors hover:text-charcoal focus-visible:bg-paper focus-visible:text-charcoal"
                >
                  <PencilLine aria-hidden className="size-4" strokeWidth={1.25} />
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
