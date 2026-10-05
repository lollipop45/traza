import { CalendarDays, CornerDownLeft, ImagePlus, Mic, SquareCheck, Tag } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";

/** Visual prototype: nothing is saved or parsed in this phase. */
export function InboxComposer() {
  return (
    <section aria-labelledby="composer-heading">
      <h2 id="composer-heading" className="sr-only">
        Nueva captura
      </h2>
      <div className="rounded-[10px] border border-charcoal/15 bg-paper transition-colors focus-within:border-charcoal/40">
        <textarea
          aria-labelledby="composer-heading"
          placeholder="Escribe una idea, tarea, nota o recordatorio..."
          rows={4}
          className="block min-h-[7.5rem] w-full resize-none bg-transparent px-4 pt-4 pb-2 text-[16px] leading-[1.5] text-charcoal outline-none placeholder:text-graphite lg:min-h-[9.5rem] lg:px-5 lg:pt-5"
        />

        <div className="flex items-center justify-between gap-2 border-t border-charcoal/10 px-1.5 py-1.5">
          <div role="group" aria-label="Completar la captura" className="flex items-center">
            <IconButton label="Adjuntar imagen o archivo" icon={ImagePlus} iconClassName="size-[18px]" />
            <IconButton label="Convertir en tarea" icon={SquareCheck} iconClassName="size-[18px]" />
            <IconButton label="Añadir fecha" icon={CalendarDays} iconClassName="size-[18px]" />
            <IconButton label="Asignar proyecto o etiqueta" icon={Tag} iconClassName="size-[18px]" />
          </div>

          <div className="flex items-center gap-1">
            <IconButton label="Dictar por voz" icon={Mic} iconClassName="size-[18px]" />
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-charcoal px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-paper outline-none transition-colors hover:bg-charcoal/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
            >
              Guardar
              <CornerDownLeft aria-hidden className="size-3.5" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
