import type { Metadata } from "next";
import { CalendarToolbar } from "@/components/calendar/CalendarToolbar";
import { DayAgenda } from "@/components/calendar/DayAgenda";
import { MonthCalendar } from "@/components/calendar/MonthCalendar";
import { UpcomingDeadlines } from "@/components/calendar/UpcomingDeadlines";
import { AppShell } from "@/components/layout/AppShell";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatMonthYear, isValidISODate } from "@/lib/calendar/dates";
import { getEventsInMonth, getEventsOn, getUpcomingDeadlines } from "@/lib/calendar/events";
import { calendarEvents, today } from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Calendario · TRAZA",
};

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  // The selected day lives in the URL (?dia=YYYY-MM-DD), so day cells are plain links and no client state is needed.
  const { dia } = await searchParams;
  const month = today;
  const selected =
    typeof dia === "string" && isValidISODate(dia) && dia.slice(0, 7) === month.slice(0, 7) ? dia : today;

  const monthEvents = getEventsInMonth(calendarEvents, month);
  const deadlineCount = monthEvents.filter((event) => event.kind === "deadline").length;
  const eventCount = monthEvents.length - deadlineCount;

  return (
    <AppShell activeHref="/calendar">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-12">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="flex flex-col gap-6 lg:col-span-7 lg:gap-8">
          <PageHeader
            title="Calendario"
            subtitle={`${formatMonthYear(month)} · ${eventCount} eventos y ${deadlineCount} entregas`}
            date={today}
          />
          <CalendarToolbar />
        </div>

        <div className="lg:col-span-7 lg:row-start-2">
          <MonthCalendar month={month} today={today} selected={selected} events={monthEvents} />
        </div>

        <div className="flex flex-col gap-10 lg:col-span-5 lg:col-start-8 lg:row-start-2 lg:gap-14">
          <DayAgenda
            date={selected}
            events={getEventsOn(calendarEvents, selected)}
            isToday={selected === today}
          />
          <UpcomingDeadlines deadlines={getUpcomingDeadlines(calendarEvents, today)} today={today} />
        </div>
      </div>
    </AppShell>
  );
}
