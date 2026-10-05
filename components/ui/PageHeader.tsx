import type { ReactNode } from "react";
import { Wordmark } from "@/components/ui/Wordmark";
import { formatCompactDate, isoWeekNumber } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";

type PageHeaderProps = {
  title: string;
  subtitle: string;
  /** The app's current date, shown in the technical tag next to the wordmark. */
  date: ISODate;
  /** Optional page-level action, aligned with the title's baseline region on the right. */
  action?: ReactNode;
};

export function PageHeader({ title, subtitle, date, action }: PageHeaderProps) {
  return (
    <header>
      <div className="flex items-center justify-between">
        <Wordmark />
        <span className="font-mono text-[11px] tracking-[0.12em] text-graphite">
          SEM {isoWeekNumber(date)} · {formatCompactDate(date)}
        </span>
      </div>

      <div className="mt-11 flex items-end justify-between gap-4 lg:mt-24">
        <h1 className="text-[44px] leading-[1.02] font-light tracking-[-0.035em] lg:text-[64px]">
          {title}
        </h1>
        {action && <div className="mb-1 lg:mb-2">{action}</div>}
      </div>
      <p className="mt-2.5 text-[15px] text-graphite lg:mt-3 lg:text-base">{subtitle}</p>
    </header>
  );
}
