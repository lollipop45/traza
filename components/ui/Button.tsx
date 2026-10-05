import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const variants = {
  /** Charcoal: the single strongest action in a view. */
  primary: "bg-charcoal text-paper hover:bg-charcoal/90",
  /** Quiet outline for secondary choices. */
  secondary: "border border-charcoal/15 text-charcoal hover:bg-paper",
};

const sizes = {
  compact: "h-9 px-3",
  /** Full-width, touch-sized: the main action of a form. */
  block: "h-12 w-full justify-center px-4",
};

type ButtonProps = {
  variant: keyof typeof variants;
  size?: keyof typeof sizes;
  type?: "button" | "submit";
  disabled?: boolean;
  children: ReactNode;
  /** Trailing icon, decorative. */
  icon?: LucideIcon;
};

/** Technical button with a mono uppercase label. */
export function Button({ variant, size = "compact", type = "button", disabled, children, icon: Icon }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-md font-mono text-[11px] uppercase tracking-[0.14em] outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage disabled:cursor-wait disabled:opacity-60 ${sizes[size]} ${variants[variant]}`}
    >
      {children}
      {Icon && <Icon aria-hidden className="size-3.5" strokeWidth={1.5} />}
    </button>
  );
}
