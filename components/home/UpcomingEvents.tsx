import { SectionHeader } from "@/components/ui/SectionHeader";
import type { UpcomingEvent } from "@/lib/mock-data";

export function UpcomingEvents({ events }: { events: UpcomingEvent[] }) {
  return (
    <section aria-labelledby="events-heading">
      <SectionHeader
        index="02"
        title="Próximos eventos"
        id="events-heading"
        meta={String(events.length).padStart(2, "0")}
      />
      <ol>
        {events.map((event, i) => {
          const isFirst = i === 0;
          const isLast = i === events.length - 1;
          return (
            <li key={event.id} className="grid grid-cols-[3.25rem_1.25rem_1fr]">
              <time className="pt-3.5 lg:pt-4 font-mono text-[13px] leading-[22px] tabular-nums text-charcoal">
                {event.time}
              </time>

              {/* Timeline: a hairline joining one node per event; the next event is marked in sage. */}
              <div aria-hidden className="relative">
                <span
                  className={`absolute left-1/2 w-px -translate-x-1/2 bg-charcoal/15 ${
                    isFirst ? "top-[25px] lg:top-[27px]" : "top-0"
                  } ${isLast ? "h-[25px] lg:h-[27px]" : "bottom-0"}`}
                />
                <span
                  className={`absolute top-[22px] left-1/2 size-[7px] lg:top-6 -translate-x-1/2 rounded-full border ${
                    isFirst ? "border-sage bg-sage" : "border-charcoal/40 bg-sand"
                  }`}
                />
              </div>

              <div className={`py-3.5 pl-2 lg:py-4 ${isLast ? "" : "border-b border-charcoal/10"}`}>
                <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em]">{event.title}</p>
                <p className="mt-1 text-[13px] text-graphite">{event.location}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
