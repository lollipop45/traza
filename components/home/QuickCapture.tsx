import { Mic, Plus } from "lucide-react";
import { ComposerBar } from "@/components/ui/ComposerBar";
import { IconButton } from "@/components/ui/IconButton";

export function QuickCapture() {
  return (
    <ComposerBar
      label="Captura rápida"
      placeholder="¿Qué necesitas recordar?"
      leading={<IconButton label="Añadir" icon={Plus} />}
      trailing={<IconButton label="Captura por voz" icon={Mic} iconClassName="size-[18px]" />}
    />
  );
}
