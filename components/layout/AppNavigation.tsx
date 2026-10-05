import Link from "next/link";
import {
  CalendarDays,
  House,
  Inbox,
  Layers,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

type NavItem = {
  label: string;
  icon: LucideIcon;
  /** Items without a route are visual placeholders until their screens exist. */
  href?: string;
};

const navItems: NavItem[] = [
  { label: "Inicio", icon: House, href: "/" },
  { label: "Calendario", icon: CalendarDays, href: "/calendar" },
  { label: "Inbox", icon: Inbox },
  { label: "Proyectos", icon: Layers },
  { label: "Asistente", icon: MessageSquare },
];

const itemClass =
  "relative flex h-full w-full flex-col items-center justify-center gap-1.5 text-[10px] font-medium tracking-[0.04em] outline-none transition-colors focus-visible:bg-sand lg:h-16";

export function AppNavigation({ activeHref }: { activeHref: string }) {
  return (
    <nav
      aria-label="Principal"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-charcoal/10 bg-paper pb-[env(safe-area-inset-bottom)] lg:inset-y-0 lg:right-auto lg:w-22 lg:border-t-0 lg:border-r lg:pb-0"
    >
      <ul className="mx-auto grid h-16 max-w-[480px] grid-cols-5 md:max-w-[560px] lg:h-full lg:max-w-none lg:grid-cols-1 lg:content-center lg:gap-2">
        {navItems.map(({ label, icon: Icon, href }) => {
          const isActive = href === activeHref;
          const content = (
            <>
              {isActive && (
                <span
                  aria-hidden
                  className="absolute top-0 left-1/2 h-px w-6 -translate-x-1/2 bg-charcoal lg:top-1/2 lg:left-0 lg:h-6 lg:w-px lg:translate-x-0 lg:-translate-y-1/2"
                />
              )}
              <Icon aria-hidden className="size-5" strokeWidth={1.25} />
              <span>{label}</span>
            </>
          );

          return (
            <li key={label}>
              {href ? (
                <Link
                  href={href}
                  aria-current={isActive ? "page" : undefined}
                  className={`${itemClass} ${isActive ? "text-charcoal" : "text-graphite hover:text-charcoal"}`}
                >
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  aria-disabled="true"
                  className={`${itemClass} cursor-default text-graphite`}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
