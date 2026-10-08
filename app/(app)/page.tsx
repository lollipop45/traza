import { AppShell } from "@/components/layout/AppShell";
import { QuickCapture } from "@/components/home/QuickCapture";
import { InstallHint } from "@/components/pwa/InstallHint";
import { TaskList } from "@/components/home/TaskList";
import { TodayOverview } from "@/components/home/TodayOverview";
import { UpcomingEvents } from "@/components/home/UpcomingEvents";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { PageHeader } from "@/components/ui/PageHeader";
import { currentISODate, formatLongDate } from "@/lib/calendar/dates";
import { compareItems, eventToItem, projectNameMap } from "@/lib/calendar/items";
import { getEventsBetween } from "@/lib/calendar/queries";
import { countActiveProjects, isAssignable } from "@/lib/projects/projects";
import { getProjectOptions } from "@/lib/projects/queries";
import { getHomeTasks } from "@/lib/tasks/queries";
import { isDone } from "@/lib/tasks/types";

export default async function Home() {
  // All real: tasks, projects, events and the date (app time zone, computed on the server and sent
  // as text, so neither the host's UTC clock nor the browser's zone can shift the day).
  const today = currentISODate();

  const [taskResult, projectResult, eventResult] = await Promise.all([
    getHomeTasks(),
    getProjectOptions(),
    getEventsBetween(today, today),
  ]);
  const tasks = taskResult.ok ? taskResult.tasks : null;
  const pendingCount = tasks ? tasks.filter((task) => !isDone(task)).length : null;
  const projects = projectResult.ok ? projectResult.projects : [];
  const activeProjectCount = projectResult.ok ? countActiveProjects(projects) : null;
  // Próximos eventos = today's calendar events (all-day first, then by start time). Task deadlines
  // stay in the task list, so nothing appears twice on Home.
  const names = projectNameMap(projects);
  const todayEvents = eventResult.ok ? eventResult.events.map((event) => eventToItem(event, names)).sort(compareItems) : null;

  return (
    <AppShell activeHref="/">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-20">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="flex flex-col gap-6 lg:col-span-7 lg:gap-8">
          <PageHeader title="Buenos días" subtitle={formatLongDate(today)} date={today} />
          <QuickCapture today={today} projects={projects.filter(isAssignable)} />
          {/* Renders nothing unless this browser can install TRAZA and the hint was not dismissed. */}
          <InstallHint />
        </div>

        <div className="lg:col-span-5 lg:self-end">
          <TodayOverview
            taskCount={pendingCount}
            eventCount={todayEvents?.length ?? null}
            projectCount={activeProjectCount}
          />
        </div>

        <div className="lg:col-span-5 lg:col-start-8 lg:row-start-2">
          <UpcomingEvents events={todayEvents} />
        </div>

        <div className="lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <TaskList tasks={tasks} pendingCount={pendingCount} today={today} projects={projects} />
        </div>
      </div>
    </AppShell>
  );
}
