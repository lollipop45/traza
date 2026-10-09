import { TrazaMark } from "@/components/ui/TrazaMark";

/**
 * What TRAZA looks like once installed: the app icon (sand ground, charcoal mark, the same
 * proportions as public/icons/icon-*.png) drawn inline, so it costs no image request.
 */
export function AppIconPreview() {
  return (
    <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-[10px] border border-charcoal/10 bg-sand text-charcoal">
      <TrazaMark className="h-[23px]" />
    </span>
  );
}
