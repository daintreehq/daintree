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
              "disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none",
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
                // Inline so framer scale-corrects the corners while the thumb resizes
                // between segments of different widths; a `rounded` class it cannot read.
                style={{ borderRadius: 4 }}
                className="absolute inset-0 z-0 bg-daintree-border pointer-events-none"
                aria-hidden="true"
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
