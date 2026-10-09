import { TrazaMark } from "@/components/ui/TrazaMark";

/** The TRAZA mark beside the tracked name. */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-3 text-charcoal">
      <TrazaMark className="h-3" />
      {/* Negative right margin cancels the trailing letter-spacing so the name stays optically flush. */}
      <span className="-mr-[0.36em] text-[13px] leading-none font-semibold tracking-[0.36em]">
        TRAZA
      </span>
    </span>
  );
}
