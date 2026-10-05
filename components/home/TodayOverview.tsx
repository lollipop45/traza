import { SectionHeader } from "@/components/ui/SectionHeader";

type TodayOverviewProps = {
  /** Real counts are null when they could not be loaded; shown as a dash. */
  taskCount: number | null;
  eventCount: number;
  /** Projects with status `active`. */
  projectCount: number | null;
};

export function TodayOverview({ taskCount, eventCount, projectCount }: TodayOverviewProps) {
  const items = [
    { value: taskCount ?? "—", label: taskCount === 1 ? "Tarea" : "Tareas" },
    { value: eventCount, label: eventCount === 1 ? "Evento" : "Eventos" },
    { value: projectCount ?? "—", label: projectCount === 1 ? "Proyecto activo" : "Proyectos activos" },
  ];

  return (
    <section aria-labelledby="today-heading">
      <SectionHeader index="01" title="Hoy" id="today-heading" />
      <dl className="grid grid-cols-3 divide-x divide-charcoal/10 border-b border-charcoal/10">
        {items.map(({ value, label }) => (
          <div
            key={label}
            className="flex flex-col-reverse gap-1.5 px-4 py-4 first:pl-0 last:pr-0 lg:py-5"
          >
            <dt className="text-[12px] leading-tight text-graphite">{label}</dt>
            <dd className="text-[32px] leading-none font-light tracking-[-0.03em] tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
