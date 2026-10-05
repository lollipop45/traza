import { DeadlineMark } from "@/components/ui/DeadlineMark";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { daysBetween, formatShortMonth, parseISODate } from "@/lib/calendar/dates";
import type { CalendarEvent, ISODate } from "@/lib/calendar/types";

function formatCountdown(days: number): string {
  if (days === 0) return "Hoy";
  if (days === 1) return "Mañana";
  return `En ${days} días`;
}

type UpcomingDeadlinesProps = {
  deadlines: CalendarEvent[];
  today: ISODate;
};

export function UpcomingDeadlines({ deadlines, today }: UpcomingDeadlinesProps) {
  return (
    <section aria-labelledby="deadlines-heading">
      <SectionHeader
        index="03"
        title="Próximas entregas"
        id="deadlines-heading"
        meta={String(deadlines.length).padStart(2, "0")}
      />
      <ul className="divide-y divide-charcoal/10">
        {deadlines.map((deadline) => {
          const remaining = daysBetween(today, deadline.date);
          return (
            <li key={deadline.id} className="grid grid-cols-[3.25rem_1fr_auto] items-start gap-x-2 py-3.5 lg:py-4">
              <time dateTime={deadline.date} className="flex flex-col">
                <span className="text-[22px] leading-none font-light tracking-[-0.02em] tabular-nums">
                  {String(parseISODate(deadline.date).getUTCDate()).padStart(2, "0")}
                </span>
                <span className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] text-graphite">
                  <DeadlineMark />
                  {formatShortMonth(deadline.date)}
                </span>
              </time>

              <div className="min-w-0 pl-2">
                <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em]">
                  {deadline.title}
                </p>
                <p className="mt-1 text-[13px] text-graphite">{deadline.course}</p>
              </div>

              <span
                className={`pt-1 font-mono text-[11px] uppercase tracking-[0.12em] ${
                  remaining <= 2 ? "text-charcoal" : "text-graphite"
                }`}
              >
                {formatCountdown(remaining)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
