import Link from "next/link";

export type FilterIndexOption = {
  key: string;
  label: string;
  href: string;
  count: number;
};

type FilterIndexProps = {
  /** Spanish accessible name of the filter navigation. */
  label: string;
  options: FilterIndexOption[];
  activeKey: string;
  /**
   * Mobile arrangement. "tabs": one underlined row (short labels). "grid": a two-column index (long labels).
   * Both become the same vertical index on desktop.
   */
  variant: "tabs" | "grid";
};

const styles = {
  tabs: {
    list: "flex gap-6 border-b border-charcoal/10 lg:flex-col lg:gap-0 lg:border-b-0",
    link: "pb-3 lg:justify-between lg:border-b lg:border-charcoal/10 lg:py-3.5 lg:pl-4",
    marker: "inset-x-0 -bottom-px h-px lg:inset-x-auto lg:top-0 lg:bottom-0 lg:left-0 lg:h-auto lg:w-px",
  },
  grid: {
    list: "grid grid-cols-2 gap-x-6 border-t border-charcoal/10 lg:grid-cols-1 lg:border-t-0",
    link: "justify-between border-b border-charcoal/10 py-3.5 pl-4",
    marker: "top-0 bottom-0 left-0 w-px",
  },
};

/** Filter links driven by a search param, so they need no client state. */
export function FilterIndex({ label, options, activeKey, variant }: FilterIndexProps) {
  const { list, link, marker } = styles[variant];
  return (
    <nav aria-label={label}>
      <ul className={list}>
        {options.map((option) => {
          const isActive = option.key === activeKey;
          return (
            <li key={option.key}>
              <Link
                href={option.href}
                scroll={false}
                aria-current={isActive ? "true" : undefined}
                className={`relative flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.14em] outline-none transition-colors focus-visible:text-charcoal ${link} ${
                  isActive ? "text-charcoal" : "text-graphite hover:text-charcoal"
                }`}
              >
                {isActive && <span aria-hidden className={`absolute bg-charcoal ${marker}`} />}
                {option.label}
                <span className="text-graphite/70 tabular-nums">
                  {String(option.count).padStart(2, "0")}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
