import type { LucideIcon } from "lucide-react";

type IconButtonProps = {
  /** Spanish accessible name; the icon itself is hidden from assistive tech. */
  label: string;
  icon: LucideIcon;
  iconClassName?: string;
  type?: "button" | "submit";
  disabled?: boolean;
};

/** Quiet square icon action used inside paper-coloured input surfaces. */
export function IconButton({ label, icon: Icon, iconClassName = "size-5", type = "button", disabled }: IconButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid size-10 shrink-0 place-items-center rounded-md text-charcoal outline-none transition-colors hover:bg-sand focus-visible:bg-sand disabled:cursor-wait disabled:opacity-50"
    >
      <Icon aria-hidden className={iconClassName} strokeWidth={1.25} />
    </button>
  );
}
