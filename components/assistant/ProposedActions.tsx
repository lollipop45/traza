"use client";

// The proposals of one assistant answer. Nothing exists until "Confirmar": the Server Action then
// re-validates each proposal and creates it at most once (repeated clicks or a refresh never
// duplicate). "Descartar" removes one proposal for good. Only proposal ids go to the server.
import { Check, X } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { confirmAssistantActions, dismissAssistantAction } from "@/lib/assistant/actions";
import type { ActionView } from "@/lib/assistant/types";
import { ProposedActionRecord } from "./ProposedActionRecord";

export function ProposedActions({ headingId, actions }: { headingId: string; actions: ActionView[] }) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const open = actions.filter((action) => action.state === "proposed");
  const status = open.length === actions.length ? "Sin confirmar" : open.length === 0 ? "Revisadas" : `${open.length} sin confirmar`;

  function confirm() {
    setNotice(null);
    startTransition(async () => {
      const result = await confirmAssistantActions(open.map((action) => action.id));
      setNotice(result.ok ? { text: result.message ?? "Hecho.", ok: true } : { text: result.error, ok: false });
    });
  }

  function dismiss(id: string) {
    setNotice(null);
    startTransition(async () => {
      const result = await dismissAssistantAction(id);
      if (!result.ok) setNotice({ text: result.error, ok: false });
    });
  }

  return (
    <section aria-labelledby={headingId} aria-busy={pending} className="mt-5">
      <div className="flex items-baseline justify-between border-b border-charcoal/10 pb-2.5 font-mono text-[10px] uppercase tracking-[0.14em]">
        <h3 id={headingId} className="text-charcoal">
          Acciones propuestas
        </h3>
        <span className="text-graphite">{status}</span>
      </div>
      <ol className="divide-y divide-charcoal/10 border-b border-charcoal/10">
        {actions.map((action, i) => (
          <ProposedActionRecord key={action.id} action={action} number={i + 1}>
            {action.state === "proposed" && actions.length > 1 && (
              <button
                type="button"
                onClick={() => dismiss(action.id)}
                disabled={pending}
                className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite outline-none hover:text-charcoal focus-visible:text-charcoal disabled:opacity-50"
              >
                <X aria-hidden className="size-3" strokeWidth={1.5} />
                Descartar esta
              </button>
            )}
          </ProposedActionRecord>
        ))}
      </ol>

      {open.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" icon={Check} onClick={confirm} disabled={pending}>
            Confirmar {open.length} {open.length === 1 ? "acción" : "acciones"}
          </Button>
          {open.length === 1 && (
            <Button variant="secondary" icon={X} onClick={() => dismiss(open[0].id)} disabled={pending}>
              Descartar
            </Button>
          )}
        </div>
      )}

      <div role="status" aria-live="polite">
        {pending && <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">Guardando…</p>}
        {!pending && notice && (
          <p className={`mt-3 border-l pl-3 text-[13px] leading-[1.5] text-charcoal ${notice.ok ? "border-sage" : "border-charcoal"}`}>{notice.text}</p>
        )}
      </div>
    </section>
  );
}
