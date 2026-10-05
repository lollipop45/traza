import { SectionHeader } from "@/components/ui/SectionHeader";
import type { ISODate } from "@/lib/calendar/types";
import { formatDueLabel } from "@/lib/tasks/format";
import { isDone, type HomeTask } from "@/lib/tasks/types";
import { TaskItem } from "./TaskItem";

type TaskListProps = {
  /** null when the tasks could not be loaded. */
  tasks: HomeTask[] | null;
  pendingCount: number | null;
  today: ISODate;
};

export function TaskList({ tasks, pendingCount, today }: TaskListProps) {
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
            <TaskItem
              key={task.id}
              id={task.id}
              title={task.title}
              done={isDone(task)}
              due={formatDueLabel(task.due_date, today)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
