/**
 * Faint drafting grid behind a page's header. Bleeds to the page gutters and up under the safe area;
 * the parent must be `relative isolate`.
 */
export function BlueprintBackdrop({ className }: { className: string }) {
  return (
    <div
      aria-hidden
      className={`blueprint-grid pointer-events-none absolute -inset-x-5 -top-[calc(env(safe-area-inset-top)+1.25rem)] -z-10 lg:-inset-x-14 lg:-top-12 ${className}`}
    />
  );
}
