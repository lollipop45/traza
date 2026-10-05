/** Placeholder wordmark: a drafting mark (square cut by its diagonal) beside the tracked name. */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-3 text-charcoal">
      <svg aria-hidden viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor">
        <rect x="0.5" y="0.5" width="9" height="9" strokeWidth="1" />
        <path d="M0.5 9.5 9.5 0.5" strokeWidth="1" />
      </svg>
      {/* Negative right margin cancels the trailing letter-spacing so the name stays optically flush. */}
      <span className="-mr-[0.36em] text-[13px] leading-none font-semibold tracking-[0.36em]">
        TRAZA
      </span>
    </span>
  );
}
