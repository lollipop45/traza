import { Mic, Plus } from "lucide-react";

const iconButtonClass =
  "grid size-10 shrink-0 place-items-center rounded-md text-charcoal outline-none transition-colors hover:bg-sand focus-visible:bg-sand";

export function QuickCapture() {
  return (
    <div className="flex h-14 items-center gap-1 rounded-[10px] border border-charcoal/15 bg-paper px-2 transition-colors focus-within:border-charcoal/40">
      <button type="button" aria-label="Añadir" className={iconButtonClass}>
        <Plus aria-hidden className="size-5" strokeWidth={1.25} />
      </button>
      <input
        type="text"
        aria-label="Captura rápida"
        placeholder="¿Qué necesitas recordar?"
        className="min-w-0 flex-1 bg-transparent px-1 text-[15px] text-charcoal outline-none placeholder:text-graphite"
      />
      <span aria-hidden className="h-6 w-px bg-charcoal/10" />
      <button type="button" aria-label="Captura por voz" className={iconButtonClass}>
        <Mic aria-hidden className="size-[18px]" strokeWidth={1.25} />
      </button>
    </div>
  );
}
