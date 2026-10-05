type ChoiceGroupProps = {
  /** Unique per page; used for the label element. */
  id: string;
  /** Visible mono label and accessible name of the group. */
  label: string;
  /** Radio name; submitted with the form when meaningful. */
  name: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
};

/**
 * Compact segmented choice built on native radio inputs (arrow-key navigation, form submission).
 * Same outline-and-hairline language as the calendar view selector.
 */
export function ChoiceGroup({ id, label, name, options, value, onChange }: ChoiceGroupProps) {
  const labelId = `${id}-label`;
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="inline-flex w-fit divide-x divide-charcoal/10 overflow-hidden rounded-md border border-charcoal/15 font-mono text-[11px] uppercase tracking-[0.14em]"
      >
        {options.map((option) => (
          <label key={option.value} className="relative">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="block h-8 cursor-pointer px-3 leading-8 text-graphite transition-colors peer-checked:bg-paper peer-checked:text-charcoal peer-focus-visible:ring-1 peer-focus-visible:ring-charcoal/50 peer-focus-visible:ring-inset hover:text-charcoal">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
