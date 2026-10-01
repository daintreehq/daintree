import { cn } from "@/lib/utils";
import type { RootAttributes } from "@/components/ui/rootAttributes";

interface ProgressBarProps {
  /** Omit (or pass `null`) while the amount is unknown: the track pulses and `aria-valuenow` is dropped. */
  value?: number | null;
  max?: number;
  /** The accessible name. Required — a bare progressbar announces nothing useful. */
  label: string;
  valueText?: string;
  /** `thin` (2px) for a bar tucked under a line of text; `default` (4px) otherwise. */
  size?: "default" | "thin";
  className?: string;
  /** `id`, `data-*` or `aria-*` on the root; the component's own attributes win. */
  rootAttributes?: RootAttributes;
}

/**
 * Task progress — a clone, a download, a push stage, files viewed. One track,
 * one fill, one easing, so every bar in the app reads as the same instrument.
 *
 * The fill is neutral `text-secondary` on an `overlay-medium` track: progress is
 * status, not a call to action, so it never spends the region's accent. Quota
 * and usage meters (`role="meter"`) are a different instrument and keep their
 * own heavier track.
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  valueText,
  size = "default",
  className,
  rootAttributes,
}: ProgressBarProps) {
  const determinate = value != null && Number.isFinite(value);
  const safeMax = max > 0 ? max : 1;
  const clamped = determinate ? Math.min(safeMax, Math.max(0, value)) : 0;
  return (
    <div
      {...rootAttributes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      {...(determinate ? { "aria-valuenow": clamped } : {})}
      {...(valueText ? { "aria-valuetext": valueText } : {})}
      className={cn(
        "w-full overflow-hidden rounded-full bg-overlay-medium",
        size === "thin" ? "h-0.5" : "h-1",
        !determinate && "animate-pulse-immediate",
        className
      )}
    >
      {determinate && (
        <div
          className="h-full rounded-full bg-text-secondary transition-[width] duration-150 ease-out"
          style={{ width: `${(clamped / safeMax) * 100}%` }}
        />
      )}
    </div>
  );
}
