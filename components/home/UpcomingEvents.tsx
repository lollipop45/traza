import { EventTimeline } from "@/components/ui/EventTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { CalendarEvent } from "@/lib/calendar/types";

export function UpcomingEvents({ events }: { events: CalendarEvent[] }) {
  return (
    <section aria-labelledby="events-heading">
      <SectionHeader
        index="02"
        title="Próximos eventos"
        id="events-heading"
        meta={String(events.length).padStart(2, "0")}
      />
      <EventTimeline events={events} highlightFirst />
    </section>
  );
}
