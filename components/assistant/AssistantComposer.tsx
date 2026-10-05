import { CornerDownLeft, Mic, Paperclip } from "lucide-react";
import { ComposerBar } from "@/components/ui/ComposerBar";
import { IconButton } from "@/components/ui/IconButton";

/** Visual prototype: instructions are not sent or interpreted in this phase. */
export function AssistantComposer() {
  return (
    <ComposerBar
      label="Instrucción para el asistente"
      placeholder="Escribe una instrucción..."
      leading={<IconButton label="Adjuntar archivo" icon={Paperclip} iconClassName="size-[18px]" />}
      trailing={
        <>
          <IconButton label="Dictar por voz" icon={Mic} iconClassName="size-[18px]" />
          <button
            type="button"
            aria-label="Enviar instrucción"
            title="Enviar instrucción"
            className="grid size-9 shrink-0 place-items-center rounded-md bg-charcoal text-paper outline-none transition-colors hover:bg-charcoal/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
          >
            <CornerDownLeft aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </>
      }
    />
  );
}
