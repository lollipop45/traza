/** Small solid square that marks an academic deadline (entrega), as opposed to the round event dot. */
export function DeadlineMark({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block size-[5px] shrink-0 bg-charcoal ${className}`} />;
}
