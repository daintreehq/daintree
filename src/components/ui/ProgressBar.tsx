import { cn } from "@/lib/utils";
import type { RootAttributes } from "@/components/ui/rootAttributes";

interface ProgressBarBaseProps {
  /** Omit (or pass `null`) while the amount is unknown: the track pulses and `aria-valuenow` is dropped. */
  value?: number | null;
  max?: number;
  /**
   * `thin` (2px) for a bar tucked under a line of text; `inline` (4px, heavier
   * track) for a short gauge sitting in a line of text, where the default track
   * is too faint to read as a shape when it is nearly empty; `default` (4px)
   * otherwise.
   */
  size?: "default" | "thin" | "inline";
  className?: string;
  /** `id`, `data-*` or `aria-*` on the root; the component's own attributes win. */
  rootAttributes?: RootAttributes;
}

type ProgressBarProps = ProgressBarBaseProps &
  (
    | {
        /** The accessible name. Required — a bare progressbar announces nothing useful. */
        label: string;
        valueText?: string;
        decorative?: false;
      }
    | {
        /**
         * Drawn only, as hidden phrasing content, for a gauge inside a control
         * whose own name already says the amount (a button can hold neither a
         * `div` nor a widget role).
         */
        decorative: true;
        label?: never;
        valueText?: never;
      }
  );

/**
 * Task progress — a clone, a download, a push stage, files viewed. One track,
 * one fill, one easing, so every bar in the app reads as the same instrument.
 *
 * The fill is neutral `text-secondary` on an `overlay-medium` track (a step
 * heavier for `inline`): progress is status, not a call to action, so it never
 * spends the region's accent. Quota and usage meters (`role="meter"`) are a
 * different instrument and keep their own heavier track.
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  valueText,
  size = "default",
  className,
  rootAttributes,
  decorative,
}: ProgressBarProps) {
  const determinate = value != null && Number.isFinite(value);
  const safeMax = max > 0 ? max : 1;
  const clamped = determinate ? Math.min(safeMax, Math.max(0, value)) : 0;
  const Root = decorative ? "span" : "div";
  const Fill = decorative ? "span" : "div";
  const semantics = decorative
    ? { "aria-hidden": true as const }
    : {
        role: "progressbar",
        "aria-label": label,
        "aria-valuemin": 0,
        "aria-valuemax": safeMax,
        ...(determinate ? { "aria-valuenow": clamped } : {}),
        ...(valueText ? { "aria-valuetext": valueText } : {}),
      };
  return (
    <Root
      {...rootAttributes}
      {...semantics}
      data-progress-bar=""
      className={cn(
        "block w-full overflow-hidden rounded-full",
        size === "inline" ? "bg-overlay-emphasis" : "bg-overlay-medium",
        size === "thin" ? "h-0.5" : "h-1",
        !determinate && "animate-pulse-immediate",
        className
      )}
    >
      {determinate && (
        <Fill
          className="block h-full rounded-full bg-text-secondary transition-[width] duration-150 ease-out reduce-motion:transition-none"
          style={{ width: `${(clamped / safeMax) * 100}%` }}
        />
      )}
    </Root>
  );
}
