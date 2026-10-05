import { EventTimeline } from "@/components/ui/EventTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { CalendarEventItem } from "@/lib/calendar/types";

/** Today's calendar events (not task deadlines: those live in the task list). */
export function UpcomingEvents({ events }: { events: CalendarEventItem[] | null }) {
  return (
    <section aria-labelledby="events-heading">
      <SectionHeader
        index="02"
        title="Próximos eventos"
        id="events-heading"
        meta={events === null ? "—" : String(events.length).padStart(2, "0")}
      />
      {events === null ? (
        <p role="alert" className="py-6 text-[14px] text-graphite">
          No se han podido cargar los eventos.
        </p>
      ) : events.length > 0 ? (
        <EventTimeline items={events} highlightFirst />
      ) : (
        <p className="py-6 text-[14px] text-graphite">Sin eventos hoy.</p>
      )}
    </section>
  );
}
