import type { CalendarEvent } from "@/lib/calendar/types";

type EventTimelineProps = {
  events: CalendarEvent[];
  /** Marks the first item in sage as the next thing happening. */
  highlightFirst?: boolean;
};

/** Hairline timeline with one node per item: round for events, square for deadlines. */
export function EventTimeline({ events, highlightFirst = false }: EventTimelineProps) {
  return (
    <ol>
      {events.map((event, i) => {
        const isFirst = i === 0;
        const isLast = i === events.length - 1;
        const isDeadline = event.kind === "deadline";
        const isHighlighted = highlightFirst && isFirst;
        return (
          <li key={event.id} className="grid grid-cols-[3.25rem_1.25rem_1fr]">
            <time
              dateTime={event.startTime ? `${event.date}T${event.startTime}` : event.date}
              className="pt-3.5 font-mono text-[13px] leading-[22px] tabular-nums text-charcoal lg:pt-4"
            >
              {event.startTime ?? "—"}
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
                    : isDeadline
                      ? "border-charcoal bg-charcoal"
                      : "border-charcoal/40 bg-sand"
                }`}
              />
            </div>

            <div className={`py-3.5 pl-2 lg:py-4 ${isLast ? "" : "border-b border-charcoal/10"}`}>
              <p className="flex items-baseline gap-2.5 text-[15px] leading-[22px] font-medium tracking-[-0.01em]">
                {event.title}
                {isDeadline && (
                  <span className="font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-graphite">
                    Entrega
                  </span>
                )}
              </p>
              <p className="mt-1 text-[13px] text-graphite">{event.location ?? event.course}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
