import { Mic, Plus } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";

export function QuickCapture() {
  return (
    <div className="flex h-14 items-center gap-1 rounded-[10px] border border-charcoal/15 bg-paper px-2 transition-colors focus-within:border-charcoal/40">
      <IconButton label="Añadir" icon={Plus} />
      <input
        type="text"
        aria-label="Captura rápida"
        placeholder="¿Qué necesitas recordar?"
        className="min-w-0 flex-1 bg-transparent px-1 text-[15px] text-charcoal outline-none placeholder:text-graphite"
      />
      <span aria-hidden className="h-6 w-px bg-charcoal/10" />
      <IconButton label="Captura por voz" icon={Mic} iconClassName="size-[18px]" />
    </div>
  );
}
