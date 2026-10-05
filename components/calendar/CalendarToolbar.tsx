import { Plus } from "lucide-react";
import { OutlineIconButton } from "@/components/ui/OutlineIconButton";

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

      <OutlineIconButton label="Nuevo evento" icon={Plus} />
    </div>
  );
}
