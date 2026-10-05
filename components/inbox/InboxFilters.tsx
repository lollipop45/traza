import Link from "next/link";
import type { InboxFilter } from "@/lib/inbox/items";

type InboxFiltersProps = {
  filters: InboxFilter[];
  active: InboxFilter;
  counts: Map<InboxFilter, number>;
};

/**
 * Type filter driven by the `?tipo=` search param, so it needs no client state.
 * A horizontal tab row on mobile; a vertical index beside the list on desktop.
 */
export function InboxFilters({ filters, active, counts }: InboxFiltersProps) {
  return (
    <nav aria-label="Filtrar por tipo">
      <ul className="flex gap-6 border-b border-charcoal/10 lg:flex-col lg:gap-0 lg:border-b-0">
        {filters.map((filter) => {
          const isActive = filter === active;
          return (
            <li key={filter.label}>
              <Link
                href={filter.slug ? `/inbox?tipo=${filter.slug}` : "/inbox"}
                scroll={false}
                aria-current={isActive ? "true" : undefined}
                className={`relative flex items-baseline gap-2 pb-3 font-mono text-[11px] uppercase tracking-[0.14em] outline-none transition-colors focus-visible:text-charcoal lg:justify-between lg:border-b lg:border-charcoal/10 lg:py-3.5 lg:pl-4 ${
                  isActive ? "text-charcoal" : "text-graphite hover:text-charcoal"
                }`}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 -bottom-px h-px bg-charcoal lg:inset-x-auto lg:top-0 lg:bottom-0 lg:left-0 lg:h-auto lg:w-px"
                  />
                )}
                {filter.label}
                <span className="text-graphite/70 tabular-nums">
                  {String(counts.get(filter) ?? 0).padStart(2, "0")}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
