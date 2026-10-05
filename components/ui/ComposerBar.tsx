import type { ReactNode } from "react";

type ComposerBarProps = {
  /** Spanish accessible name of the text field. */
  label: string;
  placeholder: string;
  leading: ReactNode;
  trailing: ReactNode;
};

/** Single-line paper input with quiet actions on either side, separated from the trailing group by a hairline. */
export function ComposerBar({ label, placeholder, leading, trailing }: ComposerBarProps) {
  return (
    <div className="flex h-14 items-center gap-1 rounded-[10px] border border-charcoal/15 bg-paper px-2 transition-colors focus-within:border-charcoal/40">
      {leading}
      <input
        type="text"
        aria-label={label}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent px-1 text-[15px] text-charcoal outline-none placeholder:text-graphite"
      />
      <span aria-hidden className="h-6 w-px bg-charcoal/10" />
      {trailing}
    </div>
  );
}
