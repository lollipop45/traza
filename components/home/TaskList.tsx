import { SectionHeader } from "@/components/ui/SectionHeader";
import type { ISODate } from "@/lib/calendar/types";
import type { ProjectOption } from "@/lib/projects/types";
import type { HomeTask } from "@/lib/tasks/types";
import { TaskItem } from "./TaskItem";

type TaskListProps = {
  /** null when the tasks could not be loaded. */
  tasks: HomeTask[] | null;
  pendingCount: number | null;
  /** Real current date (app time zone), for due labels. */
  today: ISODate;
  /** All of the user's projects; empty when they could not be loaded (rows then omit names). */
  projects: ProjectOption[];
};

export function TaskList({ tasks, pendingCount, today, projects }: TaskListProps) {
  return (
    <section aria-labelledby="tasks-heading">
      <SectionHeader
        index="03"
        title="Tareas"
        id="tasks-heading"
        meta={pendingCount === null ? "—" : String(pendingCount).padStart(2, "0")}
      />
      {tasks === null ? (
        <p role="alert" className="py-6 text-[14px] text-graphite">
          No se han podido cargar las tareas.
        </p>
      ) : tasks.length === 0 ? (
        <p className="py-6 text-[14px] text-graphite">No hay tareas pendientes.</p>
      ) : (
        <ul className="divide-y divide-charcoal/10">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} today={today} projects={projects} />
          ))}
        </ul>
      )}
    </section>
  );
}
