import { useId } from "react";
import { m } from "framer-motion";
import { useUiMotionTransition } from "@/hooks/useShouldSkipMotion";
import { cn } from "@/lib/utils";

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Screen-reader name when the visible label is an abbreviation (S/M/L). */
  ariaLabel?: string;
}

/**
 * Compact two-to-three-way mode switch used in viewer chrome (file viewer's
 * View/Diff and Split/Unified, markdown Rendered/Source). Extracted from
 * FileViewerModal so panel and dialog surfaces share one control.
 *
 * The active segment is marked by a single thumb that slides between segments:
 * one `m.div` moves via shared-layout projection rather than a background class
 * hopping from button to button. The layout id is instance-scoped — several
 * toggles render at once (FileViewerModal alone has three) and a shared id would
 * fling the thumb between unrelated controls.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  className,
  density = "default",
}: {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * `compact` for a 32px host-chrome strip.
   *
   * The default is 28px tall, which is right in a panel header and wrong in a
   * 32px bar: it leaves 2px of clearance, the bottom 1px of which is the bar's
   * own divider, so the control reads as a tab welded to the bottom edge rather
   * than a button sitting in a row. `compact` is 24px — real clearance top and
   * bottom, and the same height as an `icon-xs` button, so a strip carrying both
   * has one control height instead of two.
   */
  density?: "default" | "compact";
  /**
   * Escape hatch for a caller that cannot afford `shrink-0` — host chrome whose
   * label comes from a plugin manifest, where the widest option is not known
   * until runtime.
   *
   * Pass **both** `min-w-0` and `shrink` to let the labels truncate instead of
   * pushing the last segment out of the row. Neither alone is enough: `min-w-0`
   * only lowers the floor a flex item may shrink to, while the `shrink-0` in the
   * base says it never shrinks at all. tailwind-merge resolves the pair to the
   * caller's `shrink`.
   */
  className?: string;
}) {
  const thumbLayoutId = `${useId()}-segmented-thumb`;
  const thumbTransition = useUiMotionTransition();

  return (
    <div
      className={cn(
        "relative isolate flex bg-surface-sidebar rounded-lg p-0.5 shrink-0",
        className
      )}
    >
      {options.map((option) => {
        const isActive = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={option.disabled}
            aria-label={option.ariaLabel}
            aria-pressed={isActive}
            className={cn(
              "relative min-w-0 text-xs font-medium rounded-lg transition-colors",
              density === "compact" ? "px-2 py-0.5" : "px-2.5 py-1",
              "disabled:cursor-not-allowed disabled:pointer-events-none",
              isActive ? "text-text-primary" : "text-text-secondary hover:text-text-primary"
            )}
            title={option.ariaLabel}
          >
            {isActive && (
              <m.div
                data-slot="segmented-thumb"
                layout
                layoutId={thumbLayoutId}
                layoutCrossfade={false}
                transition={thumbTransition}
                // `rounded-lg` tracks the theme (it resolves to --theme-radius-scale), which an
                // inline pixel radius would not. framer can only scale-correct a radius it
                // reads from `style`, so the corners stretch slightly while the thumb morphs
                // between segments of different widths — a frame or two, and worth it to stay
                // theme-correct at rest.
                //
                // The fill alone cannot say which segment is selected: it sits about 1.3:1
                // against the surface behind it, deliberately quiet, and no neutral token in
                // this system reaches the 3:1 non-text floor without turning chrome into the
                // loudest thing on screen. The text step does not rescue it either — hovering
                // the UNSELECTED segment lifts its label to primary too, and at that moment
                // the 1.3:1 fill is all that is left distinguishing them. So the state is
                // carried by a hairline: one pixel of ink reads at a glance for a fraction
                // of a compliant fill's weight, and stays distinct from the focus ring,
                // which is 2px, accent-coloured and offset.
                //
                // `text-secondary`, NOT `text-muted`. `text-muted` measures 5.65:1 on
                // daintree and would look like it clears the floor easily, but it has no
                // dark-theme contrast floor at all — 2.22:1 on namib, 2.50:1 on redwoods —
                // so a load-bearing cue drawn in it fails on the themes nobody checked.
                className={cn(
                  "absolute inset-0 z-0 rounded-lg bg-border-default pointer-events-none",
                  "border border-text-secondary",
                  option.disabled && "opacity-40"
                )}
                aria-hidden="true"
              />
            )}
            {/* Dimming a disabled segment has to happen on its contents, never on the
                button: opacity below 1 would make the button a stacking context and trap
                this label beneath a thumb sliding across it from a sibling.

                `block truncate` rather than the inline default: an inline span has no
                width of its own to overflow, so a shrinking button would clip its label
                mid-glyph instead of ellipsing it. Callers that stay `shrink-0` never
                reach this — the label is only ever as narrow as its button is allowed
                to get. */}
            <span className={cn("relative z-10 block truncate", option.disabled && "opacity-40")}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
