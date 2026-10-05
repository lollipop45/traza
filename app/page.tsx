import { AppShell } from "@/components/layout/AppShell";
import { HomeHeader } from "@/components/home/HomeHeader";
import { QuickCapture } from "@/components/home/QuickCapture";
import { TaskList } from "@/components/home/TaskList";
import { TodayOverview } from "@/components/home/TodayOverview";
import { UpcomingEvents } from "@/components/home/UpcomingEvents";
import { activeProjectCount, tasks, today, upcomingEvents } from "@/lib/mock-data";

export default function Home() {
  return (
    <AppShell activeHref="/">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-20">
        <div
          aria-hidden
          className="blueprint-grid pointer-events-none absolute -inset-x-5 -top-[calc(env(safe-area-inset-top)+1.25rem)] -z-10 h-72 lg:-inset-x-14 lg:-top-12 lg:h-[26rem]"
        />

        <div className="flex flex-col gap-6 lg:col-span-7 lg:gap-8">
          <HomeHeader date={today} />
          <QuickCapture />
        </div>

        <div className="lg:col-span-5 lg:self-end">
          <TodayOverview
            taskCount={tasks.length}
            eventCount={upcomingEvents.length}
            projectCount={activeProjectCount}
          />
        </div>

        <div className="lg:col-span-5 lg:col-start-8 lg:row-start-2">
          <UpcomingEvents events={upcomingEvents} />
        </div>

        <div className="lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <TaskList tasks={tasks} />
        </div>
      </div>
    </AppShell>
  );
}
