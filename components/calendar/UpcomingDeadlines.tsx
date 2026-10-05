import { DeadlineMark } from "@/components/ui/DeadlineMark";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { daysBetween, formatShortMonth, parseISODate } from "@/lib/calendar/dates";
import type { ISODate, TaskDeadlineItem } from "@/lib/calendar/types";

/** Rows shown; the header still counts every pending deadline. */
const VISIBLE_DEADLINES = 8;

function formatCountdown(days: number): string {
  if (days < 0) return "Vencida";
  if (days === 0) return "Hoy";
  if (days === 1) return "Mañana";
  return `En ${days} días`;
}

type UpcomingDeadlinesProps = {
  /** Pending tasks with a due date, earliest first; null when they could not be loaded. */
  deadlines: TaskDeadlineItem[] | null;
  today: ISODate;
};

export function UpcomingDeadlines({ deadlines, today }: UpcomingDeadlinesProps) {
  const visible = deadlines?.slice(0, VISIBLE_DEADLINES) ?? [];
  const hidden = deadlines ? deadlines.length - visible.length : 0;

  return (
    <section aria-labelledby="deadlines-heading">
      <SectionHeader
        index="03"
        title="Próximas entregas"
        id="deadlines-heading"
        meta={deadlines === null ? "—" : String(deadlines.length).padStart(2, "0")}
      />
      {deadlines === null ? (
        <p role="alert" className="py-6 text-[14px] text-graphite">
          No se han podido cargar las entregas.
        </p>
      ) : deadlines.length === 0 ? (
        <p className="py-6 text-[14px] text-graphite">No hay tareas pendientes con fecha.</p>
      ) : (
        <ul className="divide-y divide-charcoal/10">
          {visible.map((deadline) => {
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
                  <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em] break-words">{deadline.title}</p>
                  {deadline.projectName && <p className="mt-1 text-[13px] text-graphite">{deadline.projectName}</p>}
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
      )}
      {hidden > 0 && (
        <p className="border-t border-charcoal/10 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          Y {hidden} más en Inicio
        </p>
      )}
    </section>
  );
}
