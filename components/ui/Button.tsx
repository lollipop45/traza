import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const variants = {
  /** Charcoal: the single strongest action in a view. */
  primary: "bg-charcoal text-paper hover:bg-charcoal/90",
  /** Quiet outline for secondary choices. */
  secondary: "border border-charcoal/15 text-charcoal hover:bg-paper",
};

type ButtonProps = {
  variant: keyof typeof variants;
  children: ReactNode;
  /** Trailing icon, decorative. */
  icon?: LucideIcon;
};

/** Compact technical button with a mono uppercase label. */
export function Button({ variant, children, icon: Icon }: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex h-9 items-center gap-2 rounded-md px-3 font-mono text-[11px] uppercase tracking-[0.14em] outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage ${variants[variant]}`}
    >
      {children}
      {Icon && <Icon aria-hidden className="size-3.5" strokeWidth={1.5} />}
    </button>
  );
}
