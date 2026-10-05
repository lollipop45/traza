import { AppShell } from "@/components/layout/AppShell";
import { QuickCapture } from "@/components/home/QuickCapture";
import { TaskList } from "@/components/home/TaskList";
import { TodayOverview } from "@/components/home/TodayOverview";
import { UpcomingEvents } from "@/components/home/UpcomingEvents";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { PageHeader } from "@/components/ui/PageHeader";
import { currentISODate, formatLongDate } from "@/lib/calendar/dates";
import { getEventsOn } from "@/lib/calendar/events";
import { activeProjectCount, calendarEvents, today } from "@/lib/mock-data";
import { getHomeTasks } from "@/lib/tasks/queries";
import { isDone } from "@/lib/tasks/types";

export default async function Home() {
  // Events and projects are still mock data; tasks are real (public.tasks, current user only).
  const todayEvents = getEventsOn(calendarEvents, today);
  // Real tasks use the real current date (app time zone); the mock screens keep the mock `today`.
  const taskToday = currentISODate();
  const taskResult = await getHomeTasks();
  const tasks = taskResult.ok ? taskResult.tasks : null;
  const pendingCount = tasks ? tasks.filter((task) => !isDone(task)).length : null;

  return (
    <AppShell activeHref="/">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-20">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="flex flex-col gap-6 lg:col-span-7 lg:gap-8">
          <PageHeader title="Buenos días" subtitle={formatLongDate(today)} date={today} />
          <QuickCapture today={taskToday} />
        </div>

        <div className="lg:col-span-5 lg:self-end">
          <TodayOverview
            taskCount={pendingCount}
            eventCount={todayEvents.length}
            projectCount={activeProjectCount}
          />
        </div>

        <div className="lg:col-span-5 lg:col-start-8 lg:row-start-2">
          <UpcomingEvents events={todayEvents} />
        </div>

        <div className="lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <TaskList tasks={tasks} pendingCount={pendingCount} today={taskToday} />
        </div>
      </div>
    </AppShell>
  );
}
