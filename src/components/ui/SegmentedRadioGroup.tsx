import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { cn } from "@/lib/utils";

export interface SegmentedRadioOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedRadioGroupProps<T extends string> {
  options: SegmentedRadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  disabled?: boolean;
  /** Fill the container and split it evenly between the segments. */
  fullWidth?: boolean;
  className?: string;
}

/**
 * The app's one segmented single-choice control, shared by the create-worktree
 * form's branch-mode and environment switches and by the settings shell's
 * global/project scope switch.
 *
 * Radio semantics with a real radiogroup keyboard model: arrow keys and
 * Home/End move the selection, and only the checked segment is a tab stop, so
 * the group is one stop in the tab order rather than N. `SegmentedToggle` is
 * the sibling control for `aria-pressed` toggles; this one exists because these
 * two switches are single-choice pickers, and screen readers should say so.
 *
 * The thumb slides via a measured transform rather than framer's shared-layout
 * projection: framer is a lint-restricted heavy import (#7659), and a segment's
 * width is knowable from the DOM. Measurement runs in a layout effect and on
 * container resize, so a late-loading font or a changed option list moves the
 * thumb before paint instead of leaving it stranded.
 */
export function SegmentedRadioGroup<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  disabled,
  fullWidth,
  className,
}: SegmentedRadioGroupProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const skipMotion = useShouldSkipMotion();

  const activeIndex = options.findIndex((option) => option.value === value);

  const measure = useCallback(() => {
    const button = buttonRefs.current[activeIndex];
    const container = containerRef.current;
    if (!button || !container) {
      setThumb(null);
      return;
    }
    setThumb({ left: button.offsetLeft, width: button.offsetWidth });
  }, [activeIndex]);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // The segments too, not just their container: under `fullWidth` a segment's box
    // can settle after the container's has (late font metrics, a flex reflow), and a
    // container-only observer never hears about it — which strands the thumb at zero
    // width and leaves the group with no selected mark at all.
    for (const button of buttonRefs.current) {
      if (button) observer.observe(button);
    }
    return () => observer.disconnect();
  }, [measure, options.length]);

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || options.length === 0) return;
    // Wrap from an unmatched value too: -1 still has to move somewhere sane.
    const from = activeIndex === -1 ? 0 : activeIndex;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        select((from + 1) % options.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        select((from - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        select(0);
        break;
      case "End":
        event.preventDefault();
        select(options.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative isolate rounded-[var(--radius-md)] bg-surface-inset p-0.5",
        fullWidth ? "flex w-full" : "inline-flex shrink-0",
        className
      )}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
    >
      {thumb && (
        <span
          data-slot="segmented-thumb"
          className={cn(
            "absolute top-0.5 bottom-0.5 left-0 z-0 rounded-[var(--radius-sm)] pointer-events-none",
            // Per docs/themes/interaction-state-recipes.md "Segmented Toggle Group Active
            // State": overlay-medium fill, border-strong boundary. The previous
            // panel-elevated + border-default pairing put the selected segment 1.15:1
            // against its track, well under SC 1.4.11's 3:1 for a selection indicator.
            "bg-overlay-medium border border-border-strong shadow-[var(--theme-shadow-ambient)]",
            // forced-colors discards the fill and the ambient shadow, so the thumb says
            // "selected" with a system-coloured border. Not a Highlight *fill*: that
            // makes Chromium paint a backplate behind the label and the text vanishes.
            "forced-colors:border-[Highlight]",
            // Only the thumb's own geometry animates, and reduced motion drops
            // it entirely rather than shortening it.
            !skipMotion && "transition-[translate,width] duration-150 ease-out",
            "motion-reduce:transition-none",
            disabled && "opacity-40"
          )}
          style={{ translate: `${thumb.left}px 0`, width: thumb.width }}
          aria-hidden="true"
        />
      )}
      {options.map((option, index) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            // Roving tabindex: the group is one tab stop, arrows move within it.
            tabIndex={isActive || (activeIndex === -1 && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={cn(
              "relative z-10 px-2.5 py-1 text-xs font-medium rounded-[var(--radius-sm)]",
              fullWidth && "flex-1 min-w-0 truncate",
              "transition-colors duration-150 ease-out",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1",
              "disabled:cursor-not-allowed disabled:pointer-events-none",
              isActive ? "text-daintree-text" : "text-text-secondary hover:text-daintree-text",
              // Belt and braces: if the thumb could not be measured, the checked
              // segment still has to look checked. A brighter label alone is not a
              // selected state.
              isActive &&
                !thumb &&
                "bg-overlay-medium border border-border-strong forced-colors:border-[Highlight]",
              disabled && "opacity-40"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
