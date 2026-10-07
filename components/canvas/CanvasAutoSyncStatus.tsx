import type { SyncStatusView } from "@/lib/canvas/sync-status";

// Automatic Campus sync status (server-rendered): a state, the last successful sync and how many
// assignments wait for the user's review. Never error details.
export function CanvasAutoSyncStatus({ view }: { view: SyncStatusView }) {
  const rows: [string, string][] = [
    ["Última sincronización", view.lastSync],
    ["Estado", view.status],
    ["Próxima comprobación", "Automática"],
  ];
  return (
    <section aria-labelledby="auto-sync-heading">
      <h2 id="auto-sync-heading" className="font-mono text-[11px] uppercase tracking-[0.14em]">
        Sincronización automática
      </h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[14px] leading-[1.5]">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-graphite">{term}</dt>
            <dd className={term === "Estado" ? "font-mono text-[11px] uppercase leading-[21px] tracking-[0.14em] text-charcoal" : "text-charcoal"}>{value}</dd>
          </div>
        ))}
      </dl>
      {view.reviewCount > 0 && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          {view.reviewCount === 1 ? "1 requiere revisión" : `${view.reviewCount} requieren revisión`} · usa la vista previa para decidir
        </p>
      )}
    </section>
  );
}
