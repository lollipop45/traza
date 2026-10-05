import type { ReactNode } from "react";
import { EventTimeline } from "@/components/ui/EventTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { formatDayHeading } from "@/lib/calendar/dates";
import type { CalendarEventItem, CalendarItem, ISODate } from "@/lib/calendar/types";

type DayAgendaProps = {
  date: ISODate;
  /** null when the day could not be loaded. */
  items: CalendarItem[] | null;
  isToday: boolean;
  editHref: (item: CalendarEventItem) => string;
  /** The open event editor, shown above the day's items. */
  editor?: ReactNode;
};

export function DayAgenda({ date, items, isToday, editHref, editor }: DayAgendaProps) {
  return (
    <section aria-labelledby="agenda-heading" aria-live="polite">
      <SectionHeader
        index="02"
        title={formatDayHeading(date)}
        id="agenda-heading"
        meta={items === null ? "—" : String(items.length).padStart(2, "0")}
      />
      {editor}
      {items === null ? (
        <p role="alert" className="py-6 text-[14px] text-graphite">
          No se ha podido cargar el calendario.
        </p>
      ) : items.length > 0 ? (
        <EventTimeline items={items} highlightFirst={isToday} editHref={editHref} />
      ) : (
        <p className="py-6 text-[14px] text-graphite">Sin eventos ni tareas.</p>
      )}
    </section>
  );
}
