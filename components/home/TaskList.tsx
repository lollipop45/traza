import { Check } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { Task } from "@/lib/mock-data";

export function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <section aria-labelledby="tasks-heading">
      <SectionHeader
        index="03"
        title="Tareas"
        id="tasks-heading"
        meta={String(tasks.length).padStart(2, "0")}
      />
      <ul className="divide-y divide-charcoal/10">
        {tasks.map((task) => (
          <li key={task.id}>
            {/* Native checkbox styled with CSS: toggles visually without client JS or persistence. */}
            <label className="group flex cursor-pointer items-start gap-3.5 py-3.5 lg:py-4">
              <span className="relative mt-px grid size-[18px] shrink-0 place-items-center">
                <input
                  type="checkbox"
                  className="peer absolute inset-0 cursor-pointer appearance-none rounded-full border border-charcoal/35 transition-colors checked:border-charcoal checked:bg-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
                />
                <Check
                  aria-hidden
                  className="pointer-events-none relative size-3 text-paper opacity-0 peer-checked:opacity-100"
                  strokeWidth={2}
                />
              </span>

              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium tracking-[-0.01em] transition-colors group-has-checked:text-graphite group-has-checked:line-through">
                  {task.title}
                </span>
                <span className="mt-1 block text-[13px] text-graphite">{task.area}</span>
              </span>

              <span
                className={`pt-[3px] font-mono text-[11px] uppercase tracking-[0.12em] ${
                  task.due === "Hoy" ? "text-charcoal" : "text-graphite"
                }`}
              >
                {task.due}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
