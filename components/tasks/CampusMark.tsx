/** "/ CAMPUS": a task imported from Campus Virtual. Never shows Canvas ids. */
export function CampusMark({ separated = true }: { separated?: boolean }) {
  return (
    <>
      {separated && (
        <span aria-hidden className="px-2 text-graphite/50">
          /
        </span>
      )}
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite" title="Importada de Campus Virtual">
        Campus
      </span>
    </>
  );
}
