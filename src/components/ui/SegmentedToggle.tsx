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
}: {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const thumbLayoutId = `${useId()}-segmented-thumb`;
  const thumbTransition = useUiMotionTransition();

  return (
    <div className="relative isolate flex bg-daintree-sidebar rounded p-0.5 shrink-0">
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
              "relative px-2.5 py-1 text-xs font-medium rounded transition-colors",
              "disabled:cursor-not-allowed disabled:pointer-events-none",
              isActive ? "text-daintree-text" : "text-muted-foreground hover:text-daintree-text"
            )}
          >
            {isActive && (
              <m.div
                data-slot="segmented-thumb"
                layout
                layoutId={thumbLayoutId}
                layoutCrossfade={false}
                transition={thumbTransition}
                // `rounded` tracks the theme (it resolves to --theme-radius-scale), which an
                // inline pixel radius would not. framer can only scale-correct a radius it
                // reads from `style`, so the corners stretch slightly while the thumb morphs
                // between segments of different widths — a frame or two, and worth it to stay
                // theme-correct at rest.
                className={cn(
                  "absolute inset-0 z-0 rounded bg-daintree-border pointer-events-none",
                  option.disabled && "opacity-40"
                )}
                aria-hidden="true"
              />
            )}
            {/* Dimming a disabled segment has to happen on its contents, never on the
                button: opacity below 1 would make the button a stacking context and trap
                this label beneath a thumb sliding across it from a sibling. */}
            <span className={cn("relative z-10", option.disabled && "opacity-40")}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
