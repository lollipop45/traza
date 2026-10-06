import type { Metadata } from "next";
import { CalendarToolbar } from "@/components/calendar/CalendarToolbar";
import { DayAgenda } from "@/components/calendar/DayAgenda";
import { EventForm } from "@/components/calendar/EventForm";
import { GoogleCalendarSection } from "@/components/calendar/GoogleCalendarSection";
import { MonthCalendar } from "@/components/calendar/MonthCalendar";
import { UpcomingDeadlines } from "@/components/calendar/UpcomingDeadlines";
import { AppShell } from "@/components/layout/AppShell";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { PageHeader } from "@/components/ui/PageHeader";
import { currentISODate, formatMonthYear } from "@/lib/calendar/dates";
import { buildCalendarItems, itemsOn, upcomingDeadlines } from "@/lib/calendar/items";
import { getEventsBetween } from "@/lib/calendar/queries";
import { isEventId } from "@/lib/calendar/validation";
import { calendarHref, lastDayOfMonth, resolveCalendarView } from "@/lib/calendar/view";
import { CALLBACK_MESSAGES, isCallbackCode, isCallbackStage } from "@/lib/google-calendar/connection";
import { getGoogleCalendarStatus } from "@/lib/google-calendar/queries";
import { getProjectOptions } from "@/lib/projects/queries";
import { getPendingDeadlineTasks, getTasksDueBetween } from "@/lib/tasks/queries";

export const metadata: Metadata = {
  title: "Calendario · TRAZA",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  // Navigation lives in the URL (?mes=YYYY-MM&dia=YYYY-MM-DD, plus ?nuevo or ?editar=<id> for the
  // event panel), so day cells and month arrows are plain links and no client state is needed.
  const { mes, dia, nuevo, editar, google, google_error: googleError } = await searchParams;
  const today = currentISODate();
  const { month, selected } = resolveCalendarView({ mes, dia }, today);
  const view = { month, selected };

  // Two sources of truth, merged only for rendering: events (calendar_events) and task deadlines
  // (tasks.due_date, never copied into the events table).
  const [eventResult, taskResult, pendingResult, projectResult, googleStatus] = await Promise.all([
    getEventsBetween(month, lastDayOfMonth(month)),
    getTasksDueBetween(month, lastDayOfMonth(month)),
    getPendingDeadlineTasks(),
    getProjectOptions(),
    // Connection metadata only (no Google call): the page never waits on Google.
    getGoogleCalendarStatus(),
  ]);
  // ?google=<code> is set by the OAuth callback; only known codes are shown, never raw text. In
  // development the callback also sends ?google_error=<stage> (a fixed list) to locate failures.
  const diagnosticStage = process.env.NODE_ENV !== "production" && isCallbackStage(googleError) ? googleError : null;
  const googleNotice = isCallbackCode(google)
    ? { text: diagnosticStage ? `${CALLBACK_MESSAGES[google]} (Diagnóstico: ${diagnosticStage})` : CALLBACK_MESSAGES[google], success: google === "conectado" }
    : null;
  const projects = projectResult.ok ? projectResult.projects : [];
  const items = eventResult.ok && taskResult.ok ? buildCalendarItems(eventResult.events, taskResult.tasks, projects) : null;
  const deadlines = pendingResult.ok ? upcomingDeadlines(pendingResult.tasks, projects) : null;

  const eventCount = items?.filter((item) => item.itemType === "event").length ?? 0;
  const taskCount = (items?.length ?? 0) - eventCount;

  const creating = nuevo !== undefined;
  const editing =
    isEventId(editar) && eventResult.ok ? eventResult.events.find((event) => event.id === editar) : undefined;
  const closeHref = calendarHref(view);

  return (
    <AppShell activeHref="/calendar">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-12">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="flex flex-col gap-6 lg:col-span-7 lg:gap-8">
          <PageHeader
            title="Calendario"
            subtitle={
              items
                ? `${formatMonthYear(month)} · ${plural(eventCount, "evento", "eventos")} y ${plural(taskCount, "tarea", "tareas")}`
                : formatMonthYear(month)
            }
            date={today}
          />
          <CalendarToolbar creating={creating} toggleHref={creating ? closeHref : calendarHref(view, { nuevo: true })} />
          {creating && <EventForm mode={{ kind: "create", date: selected }} projects={projects} closeHref={closeHref} />}
        </div>

        <div className="lg:col-span-7 lg:row-start-2">
          <MonthCalendar month={month} today={today} selected={selected} items={items ?? []} />
        </div>

        <div className="flex flex-col gap-10 lg:col-span-5 lg:col-start-8 lg:row-start-2 lg:gap-14">
          <DayAgenda
            date={selected}
            items={items ? itemsOn(items, selected) : null}
            isToday={selected === today}
            editHref={(item) => calendarHref({ month: item.date, selected: item.date }, { editar: item.id })}
            editor={
              editing && (
                <div className="pt-4">
                  <EventForm key={editing.id} mode={{ kind: "edit", event: editing }} projects={projects} closeHref={closeHref} />
                </div>
              )
            }
          />
          <UpcomingDeadlines deadlines={deadlines} today={today} />
          <GoogleCalendarSection status={googleStatus} notice={googleNotice} />
        </div>
      </div>
    </AppShell>
  );
}
