import { EventTimeline } from "@/components/ui/EventTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { formatDayHeading } from "@/lib/calendar/dates";
import type { CalendarEvent, ISODate } from "@/lib/calendar/types";

type DayAgendaProps = {
  date: ISODate;
  events: CalendarEvent[];
  isToday: boolean;
};

export function DayAgenda({ date, events, isToday }: DayAgendaProps) {
  return (
    <section aria-labelledby="agenda-heading" aria-live="polite">
      <SectionHeader
        index="02"
        title={formatDayHeading(date)}
        id="agenda-heading"
        meta={String(events.length).padStart(2, "0")}
      />
      {events.length > 0 ? (
        <EventTimeline events={events} highlightFirst={isToday} />
      ) : (
        <p className="py-6 text-[14px] text-graphite">Sin eventos programados.</p>
      )}
    </section>
  );
}
