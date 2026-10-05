const ticks = [25, 50, 75];

/** Hairline scale bar with quarter ticks; a sage cap marks the current point, and the whole line turns sage when complete. */
export function ProgressLine({ value, label }: { value: number; label: string }) {
  const isComplete = value >= 100;
  return (
    <div className="flex items-center gap-3">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="relative h-[7px] flex-1"
      >
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-charcoal/15" />
        {ticks.map((tick) => (
          <span
            key={tick}
            className="absolute top-1/2 h-[5px] w-px -translate-y-1/2 bg-charcoal/15"
            style={{ left: `${tick}%` }}
          />
        ))}
        <span
          className={`absolute top-1/2 left-0 h-px -translate-y-1/2 ${isComplete ? "bg-sage" : "bg-charcoal"}`}
          style={{ width: `${value}%` }}
        />
        {!isComplete && (
          <span className="absolute top-0 h-[7px] w-px bg-sage" style={{ left: `calc(${value}% - 1px)` }} />
        )}
      </div>
      <span className="w-9 text-right font-mono text-[11px] tabular-nums text-charcoal">{value}%</span>
    </div>
  );
}
