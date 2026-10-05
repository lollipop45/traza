import { Wordmark } from "@/components/ui/Wordmark";
import { formatCompactDate, isoWeekNumber } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";

type PageHeaderProps = {
  title: string;
  subtitle: string;
  /** The app's current date, shown in the technical tag next to the wordmark. */
  date: ISODate;
};

export function PageHeader({ title, subtitle, date }: PageHeaderProps) {
  return (
    <header>
      <div className="flex items-center justify-between">
        <Wordmark />
        <span className="font-mono text-[11px] tracking-[0.12em] text-graphite">
          SEM {isoWeekNumber(date)} · {formatCompactDate(date)}
        </span>
      </div>

      <h1 className="mt-11 text-[44px] leading-[1.02] font-light tracking-[-0.035em] lg:mt-24 lg:text-[64px]">
        {title}
      </h1>
      <p className="mt-2.5 text-[15px] text-graphite lg:mt-3 lg:text-base">{subtitle}</p>
    </header>
  );
}
