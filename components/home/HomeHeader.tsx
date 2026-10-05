import { Wordmark } from "@/components/ui/Wordmark";
import type { MockDate } from "@/lib/mock-data";

export function HomeHeader({ date }: { date: MockDate }) {
  return (
    <header>
      <div className="flex items-center justify-between">
        <Wordmark />
        <span className="font-mono text-[11px] tracking-[0.12em] text-graphite">
          SEM {date.week} · {date.short}
        </span>
      </div>

      <h1 className="mt-11 text-[44px] leading-[1.02] font-light tracking-[-0.035em] lg:mt-24 lg:text-[64px]">
        Buenos días
      </h1>
      <p className="mt-2.5 text-[15px] text-graphite lg:mt-3 lg:text-base">
        {date.weekday}, {date.date}
      </p>
    </header>
  );
}
