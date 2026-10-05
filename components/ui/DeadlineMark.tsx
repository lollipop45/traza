/**
 * Small square that marks a task deadline, as opposed to the round event dot. Solid while the task
 * is pending; hollow once it is done.
 */
export function DeadlineMark({ className = "", done = false }: { className?: string; done?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-[5px] shrink-0 ${done ? "border border-charcoal/50" : "bg-charcoal"} ${className}`}
    />
  );
}
