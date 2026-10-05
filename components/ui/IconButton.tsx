import type { LucideIcon } from "lucide-react";

type IconButtonProps = {
  /** Spanish accessible name; the icon itself is hidden from assistive tech. */
  label: string;
  icon: LucideIcon;
  iconClassName?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  /** For disclosure buttons: whether the controlled region is open, and its id. */
  expanded?: boolean;
  controls?: string;
};

/** Quiet square icon action used inside paper-coloured input surfaces. */
export function IconButton({
  label,
  icon: Icon,
  iconClassName = "size-5",
  type = "button",
  disabled,
  onClick,
  expanded,
  controls,
}: IconButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={label}
      title={label}
      className="grid size-10 shrink-0 place-items-center rounded-md text-charcoal outline-none transition-colors hover:bg-sand focus-visible:bg-sand disabled:cursor-wait disabled:opacity-50"
    >
      <Icon aria-hidden className={iconClassName} strokeWidth={1.25} />
    </button>
  );
}
