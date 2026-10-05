import { Plus } from "lucide-react";

const views = ["Día", "Semana", "Mes"] as const;
const activeView: (typeof views)[number] = "Mes";

export function CalendarToolbar() {
  return (
    <div className="flex items-center justify-between">
      {/* Only the month view exists in this phase; Día and Semana are placeholders. */}
      <div
        role="group"
        aria-label="Vista del calendario"
        className="inline-flex divide-x divide-charcoal/10 rounded-md border border-charcoal/15 font-mono text-[11px] uppercase tracking-[0.14em]"
      >
        {views.map((view) => {
          const isActive = view === activeView;
          return (
            <button
              key={view}
              type="button"
              aria-pressed={isActive}
              aria-disabled={isActive ? undefined : "true"}
              className={`h-9 px-3.5 outline-none transition-colors first:rounded-l-[5px] last:rounded-r-[5px] focus-visible:bg-paper ${
                isActive ? "bg-paper text-charcoal" : "cursor-default text-graphite"
              }`}
            >
              {view}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        aria-label="Nuevo evento"
        title="Nuevo evento"
        className="grid size-9 place-items-center rounded-md border border-charcoal/15 text-charcoal outline-none transition-colors hover:bg-paper focus-visible:border-charcoal/40 focus-visible:bg-paper"
      >
        <Plus aria-hidden className="size-[18px]" strokeWidth={1.25} />
      </button>
    </div>
  );
}
