/**
 * The official TRAZA mark (public/brand/traza-mark.svg, vectorised from brand/traza-mark-source.png):
 * a square frame cut by a diagonal band into three solid parts. Drawn in currentColor; size it by
 * height (`h-*`) and the width follows the master's proportions. Decorative: the name beside it is
 * the accessible label.
 */
export const TRAZA_MARK_VIEWBOX = "0 0 364.57 351.34";
export const TRAZA_MARK_PATH =
  "M0 0L277.06 0L223.93 52.22L51.93 52.22L51.93 196.77L0 246.15ZM325.69 0L364.57 0L364.57 40.17L39.02 351.34L0 351.34L0 309.51ZM364.57 101.51L364.57 351.34L83.72 351.34L135.04 301.06L309.18 301.06L309.18 156.07Z";

export function TrazaMark({ className = "h-3" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox={TRAZA_MARK_VIEWBOX} className={`w-auto shrink-0 ${className}`} fill="currentColor">
      <path d={TRAZA_MARK_PATH} />
    </svg>
  );
}
