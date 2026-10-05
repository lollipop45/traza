import type { LucideIcon } from "lucide-react";
import Link from "next/link";

type OutlineIconButtonProps = {
  label: string;
  icon: LucideIcon;
  iconClassName?: string;
  /** Renders a link instead of a button, e.g. to open a panel driven by a search param. */
  href?: string;
};

const className =
  "grid size-9 shrink-0 place-items-center rounded-md border border-charcoal/15 text-charcoal outline-none transition-colors hover:bg-paper focus-visible:border-charcoal/40 focus-visible:bg-paper";

/** Small outlined square action on the sand background, e.g. "Nuevo evento". */
export function OutlineIconButton({ label, icon: Icon, iconClassName = "size-[18px]", href }: OutlineIconButtonProps) {
  const icon = <Icon aria-hidden className={iconClassName} strokeWidth={1.25} />;
  if (href) {
    return (
      <Link href={href} scroll={false} aria-label={label} title={label} className={className}>
        {icon}
      </Link>
    );
  }
  return (
    <button type="button" aria-label={label} title={label} className={className}>
      {icon}
    </button>
  );
}
