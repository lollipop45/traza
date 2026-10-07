"use client";

// Manual Campus sync. Both buttons call Server Actions that verify the session, read Canvas on the
// server and return counts plus the assignments worth seeing. "Vista previa" writes nothing;
// "Sincronizar Campus" imports or updates tasks right away (the automatic sync, triggered by the
// private layout, runs the same engine at most every 30 minutes). Review decisions
// ("Importar" / "Ignorar") are explicit, per assignment, and re-verified against Canvas.
import { RefreshCw } from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { formatDayMonth } from "@/lib/calendar/dates";
import { ignoreCanvasAssignment, includeCanvasAssignment } from "@/lib/canvas/assignment-actions";
import type { AssignmentDecisionResult } from "@/lib/canvas/assignment-decisions";
import type { CanvasSyncResult, SyncItem, SyncItemGroup, SyncMode } from "@/lib/canvas/sync";
import { previewCanvasSync, syncCanvasAssignments } from "@/lib/canvas/sync-actions";
import { courseReportLine, itemLine, omittedFootnote, previewTotalsLine, syncTotalsLine, syncWarnings } from "@/lib/canvas/sync-format";

export function CanvasSyncPanel({ linkedCount }: { linkedCount: number }) {
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState<SyncMode | null>(null);
  const [result, setResult] = useState<CanvasSyncResult | null>(null);

  function run(mode: SyncMode) {
    setRunning(mode);
    startTransition(async () => {
      const next = mode === "preview" ? await previewCanvasSync() : await syncCanvasAssignments();
      setResult(next);
      setRunning(null);
    });
  }

  const summary = result?.ok ? result.summary : null;
  const warnings = summary ? syncWarnings(summary) : [];
  const group = (name: SyncItemGroup) => summary?.items.filter((item) => item.group === name) ?? [];
  const autoIgnored = group("auto-ignored");
  const oldCount = summary ? summary.omitted - autoIgnored.length : 0;

  return (
    <section aria-labelledby="sync-heading" aria-busy={pending} className="border-y border-charcoal/10 py-5">
      <h2 id="sync-heading" className="font-mono text-[11px] uppercase tracking-[0.14em]">
        Entregas de Campus
      </h2>
      <p className="mt-2 max-w-[52ch] text-[14px] leading-[1.55] text-graphite">
        {linkedCount === 0
          ? "Vincula un curso a un proyecto para importar sus entregas como tareas."
          : `Importa las entregas de ${linkedCount === 1 ? "tu curso vinculado" : `tus ${linkedCount} cursos vinculados`} como tareas. Revisa antes la vista previa: no guarda nada.`}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => run("preview")} disabled={pending || linkedCount === 0}>
          Vista previa
        </Button>
        <Button variant="primary" onClick={() => run("sync")} disabled={pending || linkedCount === 0} icon={RefreshCw}>
          Sincronizar Campus
        </Button>
      </div>

      <div role="status" aria-live="polite">
        {running && (
          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
            {running === "preview" ? "Leyendo Campus…" : "Sincronizando…"}
          </p>
        )}

        {!running && result && !result.ok && (
          <p className="mt-4 border-l border-charcoal pl-3 text-[14px] leading-[1.5] text-charcoal">
            {result.error}
            <span className="mt-1 block text-[13px] text-graphite">No se ha cambiado nada.</span>
          </p>
        )}

        {!running && summary && (
          <div className="mt-5">
            <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em]">
              {summary.mode === "preview" ? "Vista previa · no se ha guardado nada" : "Campus sincronizado"}
            </p>
            <p className="mt-1 font-mono text-[10px] uppercase leading-[1.7] tracking-[0.14em] text-graphite">
              {summary.mode === "preview" ? previewTotalsLine(summary) : syncTotalsLine(summary)}
            </p>

            {warnings.map((warning) => (
              <p key={warning} className="mt-3 border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
                {warning}
              </p>
            ))}
          </div>
        )}
      </div>

      {!running && summary && (
        <div className="mt-5 flex flex-col">
          <ItemGroup title="Revisar" items={group("review")} open hint="No se importan hasta que decidas.">
            {(item) => <ReviewActions item={item} />}
          </ItemGroup>
          <ItemGroup title="Importadas · revisar" items={group("imported-review")} open hint="Ya son tareas, pero no parecen trabajo para entregar. No se borran solas.">
            {(item) => <ReviewActions item={item} importedOnly />}
          </ItemGroup>
          <ItemGroup title={summary.mode === "preview" ? "Se importarán" : "Sincronizadas"} items={group("import")} />
          <ItemGroup title="Omitidas automáticamente" items={autoIgnored} />

          {(oldCount > 0 || summary.userIgnored > 0) && (
            <p className="border-t border-charcoal/10 pt-3 font-mono text-[10px] uppercase leading-[1.7] tracking-[0.14em] text-graphite">
              {omittedFootnote(summary.userIgnored, oldCount)}
            </p>
          )}

          {summary.courses.length > 0 && (
            <details className="group mt-3 border-t border-charcoal/10 pt-3">
              <summary className="flex cursor-pointer list-none items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-graphite outline-none focus-visible:text-charcoal">
                <span>Por curso</span>
                <span>{String(summary.courses.length).padStart(2, "0")}</span>
              </summary>
              <ol className="mt-2 divide-y divide-charcoal/10">
                {summary.courses.map((course, i) => (
                  <li key={i} className="py-3">
                    <p className="text-[14px] leading-[20px] break-words">
                      {course.courseName}
                      {course.projectName && <span className="text-graphite"> → {course.projectName}</span>}
                    </p>
                    <p className="mt-1 font-mono text-[10px] uppercase leading-[1.7] tracking-[0.14em] text-graphite">{courseReportLine(course)}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function ItemGroup({
  title,
  items,
  open = false,
  hint,
  children,
}: {
  title: string;
  items: SyncItem[];
  open?: boolean;
  hint?: string;
  children?: (item: SyncItem) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <details open={open} className="group border-t border-charcoal/10 py-3">
      <summary className="flex cursor-pointer list-none items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] outline-none focus-visible:text-charcoal">
        <span>{title}</span>
        <span className="text-graphite">
          <span className="group-open:hidden">Mostrar</span>
          <span className="hidden group-open:inline">Ocultar</span> · {String(items.length).padStart(2, "0")}
        </span>
      </summary>
      {hint && <p className="mt-2 text-[13px] text-graphite">{hint}</p>}
      <ol className="mt-1 divide-y divide-charcoal/10">
        {items.map((item) => (
          <li key={`${item.courseId}-${item.assignmentId}`} className="py-3">
            <p className="flex flex-wrap items-baseline gap-x-2.5 text-[14px] leading-[20px] break-words">
              <span>{item.title}</span>
              {item.dueDate && <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-graphite">{formatDayMonth(item.dueDate)}</span>}
            </p>
            <p className="mt-1 text-[13px] leading-[1.45] break-words text-graphite">{itemLine(item)}</p>
            {children?.(item)}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Importar / Ignorar for one listed assignment. Each choice is saved at once and re-verified. */
function ReviewActions({ item, importedOnly = false }: { item: SyncItem; importedOnly?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function decide(action: () => Promise<AssignmentDecisionResult>, doneText: (removedTask: boolean) => string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) setDone(doneText(result.removedTask));
      else setError(result.error);
    });
  }

  if (done) return <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">{done}</p>;

  return (
    <div className="mt-2" aria-busy={pending}>
      <div className="flex flex-wrap gap-2">
        {!importedOnly && (
          <Button variant="secondary" disabled={pending} onClick={() => decide(() => includeCanvasAssignment(item.courseId, item.assignmentId), () => "Se importará al sincronizar")}>
            Importar
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => decide(() => ignoreCanvasAssignment(item.courseId, item.assignmentId), (removed) => (removed ? "Ignorada · tarea quitada de TRAZA" : "Ignorada"))}
        >
          {importedOnly ? "Ignorar en TRAZA" : "Ignorar"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}
    </div>
  );
}
