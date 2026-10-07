"use client";

// Sends one instruction to the assistant (Server Action). While it waits, the composer is locked so
// a message cannot be sent twice. Suggestions only fill the field: nothing is sent until "Enviar".
import { CornerDownLeft, CornerDownRight, Sparkle } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { ComposerBar } from "@/components/ui/ComposerBar";
import { sendAssistantMessage } from "@/lib/assistant/actions";

type AssistantComposerProps = {
  conversationId: string | null;
  suggestions: string[];
  configured: boolean;
};

const MAX_LENGTH = 2000;

export function AssistantComposer({ conversationId, suggestions, configured }: AssistantComposerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function field(): HTMLInputElement | null {
    const input = formRef.current?.elements.namedItem("text");
    return input instanceof HTMLInputElement ? input : null;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const input = field();
    const text = input?.value ?? "";
    if (!text.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await sendAssistantMessage(conversationId, text);
      if (result.ok) formRef.current?.reset();
      else setError(result.error);
    });
  }

  function suggest(text: string) {
    const input = field();
    if (!input) return;
    input.value = text;
    input.focus();
  }

  return (
    <div className="flex flex-col gap-3">
      {suggestions.length > 0 && (
        <ul aria-label="Sugerencias">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => suggest(suggestion)}
                className="inline-flex items-center gap-2.5 py-1.5 text-left text-[14px] text-charcoal underline-offset-4 outline-none hover:underline hover:decoration-charcoal/30 focus-visible:underline"
              >
                <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-graphite" strokeWidth={1.5} />
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form ref={formRef} onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending || !configured} className="min-w-0">
          <ComposerBar
            label="Instrucción para el asistente"
            placeholder={configured ? "Escribe una pregunta o una instrucción..." : "El asistente no está configurado"}
            name="text"
            maxLength={MAX_LENGTH}
            describedBy="assistant-composer-status"
            leading={
              <span aria-hidden className="grid size-9 shrink-0 place-items-center text-graphite">
                <Sparkle className="size-[16px]" strokeWidth={1.25} />
              </span>
            }
            trailing={
              <button
                type="submit"
                aria-label="Enviar instrucción"
                title="Enviar instrucción"
                className="grid size-9 shrink-0 place-items-center rounded-md bg-charcoal text-paper outline-none transition-colors hover:bg-charcoal/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage disabled:opacity-50"
              >
                <CornerDownLeft aria-hidden className="size-4" strokeWidth={1.5} />
              </button>
            }
          />
        </fieldset>
      </form>

      <div id="assistant-composer-status" role="status" aria-live="polite">
        {pending && <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">Consultando tus datos…</p>}
        {!pending && error && <p className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">{error}</p>}
        {!configured && (
          <p className="text-[13px] leading-[1.5] text-graphite">Falta la clave del proveedor de IA en el servidor (docs/supabase.md · Asistente).</p>
        )}
      </div>
    </div>
  );
}
