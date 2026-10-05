import type { LucideIcon } from "lucide-react";

/** Small outlined square action on the sand background, e.g. "Nuevo evento". */
export function OutlineIconButton({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-9 shrink-0 place-items-center rounded-md border border-charcoal/15 text-charcoal outline-none transition-colors hover:bg-paper focus-visible:border-charcoal/40 focus-visible:bg-paper"
    >
      <Icon aria-hidden className="size-[18px]" strokeWidth={1.25} />
    </button>
  );
}
