import Link from "next/link";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { DeadlineMark } from "@/components/ui/DeadlineMark";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { buildMonthWeeks, formatDayHeading, formatMonthYear, type MonthDay } from "@/lib/calendar/dates";
import { groupItemsByDate } from "@/lib/calendar/items";
import type { CalendarItem, ISODate } from "@/lib/calendar/types";
import { adjacentMonthHrefs, calendarHref } from "@/lib/calendar/view";

const weekdays = [
  { short: "L", long: "lunes" },
  { short: "M", long: "martes" },
  { short: "X", long: "miércoles" },
  { short: "J", long: "jueves" },
  { short: "V", long: "viernes" },
  { short: "S", long: "sábado" },
  { short: "D", long: "domingo" },
];

/** Dots/squares shown under a day number before collapsing into "+n". */
const MAX_MARKERS = 3;

type MonthCalendarProps = {
  /** First day of the displayed month. */
  month: ISODate;
  today: ISODate;
  selected: ISODate;
  /** Real events and task deadlines of the month. */
  items: CalendarItem[];
};

export function MonthCalendar({ month, today, selected, items }: MonthCalendarProps) {
  const weeks = buildMonthWeeks(month);
  const itemsByDate = groupItemsByDate(items);
  const title = formatMonthYear(month);
  const { previous, next } = adjacentMonthHrefs(month);

  return (
    <section aria-labelledby="month-heading">
      <SectionHeader
        index="01"
        title={title}
        id="month-heading"
        action={
          <>
            <MonthNavLink label="Mes anterior" icon={ChevronLeft} href={previous} />
            <MonthNavLink label="Mes siguiente" icon={ChevronRight} href={next} />
          </>
        }
      />

      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {weekdays.map(({ short, long }, i) => (
              <th
                key={long}
                scope="col"
                className={`py-3 text-center font-mono text-[11px] font-normal tracking-[0.12em] lg:pl-3 lg:text-left ${
                  i >= 5 ? "text-graphite/70" : "text-graphite"
                }`}
              >
                <abbr title={long} className="inline-block text-center no-underline lg:w-7">
                  {short}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="border-b border-charcoal/10">
          {weeks.map((week) => (
            <tr key={week[0].date} className="border-t border-charcoal/10">
              {week.map((day) => (
                <td key={day.date} className="border-l border-charcoal/[0.06] p-0 first:border-l-0">
                  <DayCell
                    day={day}
                    items={itemsByDate.get(day.date) ?? []}
                    isToday={day.date === today}
                    isSelected={day.date === selected}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div
        aria-hidden
        className="flex gap-6 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite"
      >
        <span className="inline-flex items-center gap-2">
          <span className="size-1 rounded-full bg-graphite" />
          Evento
        </span>
        <span className="inline-flex items-center gap-2">
          <DeadlineMark />
          Tarea
        </span>
      </div>
    </section>
  );
}

/** Plain link to the adjacent month (null at the edge of the supported range). */
function MonthNavLink({ label, icon: Icon, href }: { label: string; icon: LucideIcon; href: string | null }) {
  const className = "grid size-8 place-items-center rounded-md outline-none focus-visible:bg-paper";
  if (!href) {
    return (
      <span aria-hidden className={`${className} text-graphite/40`}>
        <Icon className="size-4" strokeWidth={1.25} />
      </span>
    );
  }
  return (
    <Link href={href} scroll={false} aria-label={label} title={label} className={`${className} text-charcoal transition-colors hover:bg-paper`}>
      <Icon aria-hidden className="size-4" strokeWidth={1.25} />
    </Link>
  );
}

const cellClass =
  "relative flex h-14 flex-col items-center gap-1.5 pt-2 lg:h-[76px] lg:items-start lg:px-3 lg:pt-3";

type DayCellProps = {
  day: MonthDay;
  items: CalendarItem[];
  isToday: boolean;
  isSelected: boolean;
};

function DayCell({ day, items, isToday, isSelected }: DayCellProps) {
  if (!day.inMonth) {
    return (
      <span aria-hidden className={`${cellClass} text-graphite/35`}>
        <span className="grid size-7 place-items-center text-[14px] tabular-nums">{day.day}</span>
      </span>
    );
  }

  const label = [
    formatDayHeading(day.date),
    items.length === 0 ? "sin eventos" : `${items.length} ${items.length === 1 ? "elemento" : "elementos"}`,
    isToday && "hoy",
    isSelected && "seleccionado",
  ]
    .filter(Boolean)
    .join(", ");

  const overflow = items.length - MAX_MARKERS;

  return (
    <Link
      href={calendarHref({ month: day.date, selected: day.date })}
      scroll={false}
      aria-label={label}
      aria-current={isToday ? "date" : undefined}
      className={`${cellClass} outline-none transition-colors hover:bg-paper/70 focus-visible:bg-paper focus-visible:ring-1 focus-visible:ring-charcoal/40 focus-visible:ring-inset ${
        isSelected ? "bg-paper" : ""
      }`}
    >
      {isToday && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-sage" />}
      <span
        className={`grid size-7 place-items-center rounded-[4px] text-[14px] tabular-nums ${
          isToday
            ? "bg-charcoal text-paper"
            : isSelected
              ? "border border-charcoal text-charcoal"
              : "text-charcoal"
        }`}
      >
        {day.day}
      </span>
      {items.length > 0 && (
        <span aria-hidden className="flex h-[5px] items-center gap-[3px] lg:px-2">
          {items.slice(0, MAX_MARKERS).map((item) =>
            item.itemType === "task-deadline" ? (
              <DeadlineMark key={`task-${item.id}`} done={item.done} />
            ) : (
              <span key={`event-${item.id}`} className="size-1 rounded-full bg-graphite" />
            ),
          )}
          {overflow > 0 && (
            <span className="font-mono text-[9px] leading-none text-graphite">+{overflow}</span>
          )}
        </span>
      )}
    </Link>
  );
}
