"use client";

// Manual Google Calendar sync. "Vista previa Google" plans and writes nothing; "Sincronizar Google
// Calendar" carries out that same plan. Both are Server Actions returning aggregate counts and the
// user's own titles/dates only. The same engine also runs automatically, quietly, while TRAZA is
// open (GoogleCalendarAutoSyncTrigger); these buttons run it right away.
import { RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { formatDayMonth } from "@/lib/calendar/dates";
import type { GoogleSyncResult, SyncMode } from "@/lib/google-calendar/sync";
import { previewGoogleCalendarSync, syncGoogleCalendar } from "@/lib/google-calendar/sync-actions";
import { DETAIL_GROUPS, detailGroupTitle, summaryLines, summaryNotes, windowLine } from "@/lib/google-calendar/sync-format";

const labelClass = "font-mono text-[10px] uppercase tracking-[0.14em] text-graphite";

export function GoogleSyncPanel() {
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState<SyncMode | null>(null);
  const [result, setResult] = useState<GoogleSyncResult | null>(null);

  function run(mode: SyncMode) {
    setRunning(mode);
    startTransition(async () => {
      setResult(mode === "preview" ? await previewGoogleCalendarSync() : await syncGoogleCalendar());
      setRunning(null);
    });
  }

  const summary = result?.ok ? result.summary : null;

  return (
    <div aria-busy={pending} className="flex flex-col gap-3 border-t border-charcoal/10 pt-4">
      <p className="max-w-[52ch] text-[13px] leading-[1.55] text-graphite">
        Envía tus eventos y entregas a Google y trae los eventos de ese calendario. Las copias de TRAZA en Google se rehacen desde TRAZA; los
        eventos de Google se editan en Google. Revisa antes la vista previa: no guarda nada.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => run("preview")} disabled={pending}>
          Vista previa Google
        </Button>
        <Button variant="primary" onClick={() => run("sync")} disabled={pending} icon={RefreshCw}>
          Sincronizar Google Calendar
        </Button>
      </div>

      <div role="status" aria-live="polite">
        {running && <p className={labelClass}>{running === "preview" ? "Leyendo Google Calendar…" : "Sincronizando…"}</p>}

        {!running && result && !result.ok && (
          <p className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">{result.error}</p>
        )}

        {!running && summary && (
          <div className="flex flex-col gap-2">
            <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em]">
              {summary.mode === "preview" ? "Vista previa · no se ha guardado nada" : "Google Calendar sincronizado"}
            </p>
            <p className={`${labelClass} leading-[1.7]`}>
              {summary.calendarName} · {windowLine(summary)}
            </p>
            <ul className="flex flex-col gap-0.5 text-[14px] leading-[1.5]">
              {summaryLines(summary).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {summaryNotes(summary).map((note) => (
              <p key={note} className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
                {note}
              </p>
            ))}
            <SyncDetails summary={summary} />
          </div>
        )}
      </div>
    </div>
  );
}

function SyncDetails({ summary }: { summary: NonNullable<Extract<GoogleSyncResult, { ok: true }>["summary"]> }) {
  const groups = DETAIL_GROUPS.map((group) => ({ group, items: summary.details.filter((detail) => detail.group === group) })).filter(({ items }) => items.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col">
      {groups.map(({ group, items }) => (
        <details key={group} className="group border-t border-charcoal/10 py-2.5">
          <summary className="flex cursor-pointer list-none items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] outline-none focus-visible:text-charcoal">
            <span>{detailGroupTitle(group, summary.mode)}</span>
            <span className="text-graphite">
              <span className="group-open:hidden">Mostrar</span>
              <span className="hidden group-open:inline">Ocultar</span> · {String(items.length).padStart(2, "0")}
            </span>
          </summary>
          <ol className="mt-1 divide-y divide-charcoal/10">
            {items.map((item, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2.5 py-2 text-[14px] leading-[20px] break-words">
                <span>{item.title}</span>
                {item.date && <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-graphite">{formatDayMonth(item.date)}</span>}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}
