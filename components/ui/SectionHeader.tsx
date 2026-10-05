type SectionHeaderProps = {
  index: string;
  title: string;
  id: string;
  meta?: string;
};

/** Numbered drawing-sheet style label: "01  TODAY ............ meta" over a hairline. */
export function SectionHeader({ index, title, id, meta }: SectionHeaderProps) {
  return (
    <div className="flex items-baseline gap-4 border-b border-charcoal/10 pb-3 font-mono text-[11px] uppercase tracking-[0.16em]">
      <span aria-hidden className="text-graphite/70">
        {index}
      </span>
      <h2 id={id} className="font-medium text-charcoal">
        {title}
      </h2>
      {meta && <span className="ml-auto text-graphite">{meta}</span>}
    </div>
  );
}
