import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SegmentedRadioOption<T extends string> {
  value: T;
  label: string;
  /** Unavailable right now. Skipped by the arrow keys; still shown as checked if it is. */
  disabled?: boolean;
  /** Screen-reader name when the visible label is an abbreviation ("60d") or truncates. */
  ariaLabel?: string;
  /** Hover detail — a shortcut, or the full name behind a truncated label. */
  tooltip?: ReactNode;
}

interface SegmentedRadioGroupProps<T extends string> {
  options: SegmentedRadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  /** Help text for the whole group, e.g. a settings row's description. */
  "aria-describedby"?: string;
  /** The group's current value was rejected — a failed save, say. */
  "aria-invalid"?: boolean;
  disabled?: boolean;
  /** Fill the container and split it evenly between the segments. */
  fullWidth?: boolean;
  /**
   * `compact` (24px) for a 32px chrome strip — a pane toolbar, a palette header
   * or footer — where the default 28px leaves 2px of clearance and reads as a
   * tab welded to the strip's bottom edge. It is also the height of an
   * `icon-xs` button, so a strip carrying both has one control height.
   */
  density?: "default" | "compact";
  /** `data-testid` for the group; each segment gets `${testId}-${value}`. */
  testId?: string;
  /**
   * Pass `min-w-0 shrink` to let the labels truncate instead of pushing the
   * last segment out of the row — for a label whose width is only known at
   * runtime. `min-w-0` alone is not enough: the base `shrink-0` says the group
   * never shrinks at all. tailwind-merge resolves the pair to the caller's
   * `shrink`.
   */
  className?: string;
}

/**
 * The app's one segmented single-choice control: every mode switch, scope
 * switch and range picker — settings rows, pane toolbars (diff layout, file
 * view mode, review hub diff mode), palettes (prompt history scope, fleet
 * commit mode, theme browser appearance), the image diff and the pulse card.
 * Anything that picks exactly one of a few options uses this, so they all look,
 * answer the keyboard and move the same way.
 *
 * Radio semantics with a real radiogroup keyboard model: arrow keys and
 * Home/End move the selection, skipping disabled segments, and only one
 * segment is a tab stop — the checked one, or the first enabled one when the
 * checked segment is disabled or nothing matches — so the group is one stop in
 * the tab order rather than N. Keys the group handles stop propagating, so a
 * palette or list around it does not also act on the same press.
 *
 * The thumb slides via a measured transform rather than framer's shared-layout
 * projection: framer is a lint-restricted heavy import (#7659), and a segment's
 * width is knowable from the DOM. Measurement runs in a layout effect and on
 * container resize, so a late-loading font or a changed option list moves the
 * thumb before paint instead of leaving it stranded.
 *
 * Only the user's own pick slides the thumb. Every other move snaps: a value
 * loaded after mount, a rollback, and above all a group that was measured while
 * hidden (a `display: none` tab panel reads as zero) and resized on reveal —
 * otherwise opening a surface replays a selection nobody just made.
 */
export function SegmentedRadioGroup<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  disabled,
  fullWidth,
  density = "default",
  testId,
  className,
}: SegmentedRadioGroupProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number; animate: boolean } | null>(
    null
  );
  const pendingPickRef = useRef<T | null>(null);
  const skipMotion = useShouldSkipMotion();

  const activeIndex = options.findIndex((option) => option.value === value);
  const activeOption = activeIndex === -1 ? undefined : options[activeIndex];
  const firstEnabled = options.findIndex((option) => !option.disabled);
  // Roving tabindex: the checked segment, unless it cannot take focus.
  const tabStop = activeOption && !activeOption.disabled ? activeIndex : firstEnabled;

  const measure = useCallback(
    (animate: boolean) => {
      const button = buttonRefs.current[activeIndex];
      const container = containerRef.current;
      if (!button || !container) {
        setThumb(null);
        return;
      }
      const left = button.offsetLeft;
      const width = button.offsetWidth;
      // A re-measure that finds the same geometry is not a move. A new observer
      // always reports once on attach — and one is attached on every value
      // change — so without this its first report would strip the transition
      // from a slide the user's pick had just started.
      setThumb((prev) =>
        !animate && prev && prev.left === left && prev.width === width
          ? prev
          : { left, width, animate }
      );
    },
    [activeIndex]
  );

  useLayoutEffect(() => {
    const picked = pendingPickRef.current;
    pendingPickRef.current = null;
    measure(picked !== null && picked === value);
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(container);
    // The segments too, not just their container: under `fullWidth` a segment's box
    // can settle after the container's has (late font metrics, a flex reflow), and a
    // container-only observer never hears about it — which strands the thumb at zero
    // width and leaves the group with no selected mark at all.
    for (const button of buttonRefs.current) {
      if (button) observer.observe(button);
    }
    return () => observer.disconnect();
  }, [measure, options.length, value]);

  const pick = (next: T) => {
    // Re-picking the checked segment is not a change: the owner is not told, so
    // an inert click cannot refetch or persist. It still clears the intent, so a
    // pick the owner rejected can't make a later outside change to that option slide.
    if (next === value) {
      pendingPickRef.current = null;
      return;
    }
    pendingPickRef.current = next;
    onChange(next);
  };

  const select = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    pick(option.value);
    buttonRefs.current[index]?.focus();
  };

  /** The next enabled segment from `from` in `step` direction, wrapping; -1 if none. */
  const nextEnabled = (from: number, step: 1 | -1): number => {
    for (let i = 1; i <= options.length; i++) {
      const index = (((from + step * i) % options.length) + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return -1;
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || firstEnabled === -1) return;
    // Chords belong to the app (word-jump, tab switching), as they do in a toolbar.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // Move from where the keyboard is, not from the selection. They differ after a
    // rejected change — the owner rolls `value` back while focus stays on the option
    // the user tried — and stepping from the selection would re-attempt that same
    // option instead of moving past it. Wrap from an unmatched value too.
    const focusedIndex = buttonRefs.current.findIndex(
      (button) => button !== null && button === document.activeElement
    );
    const from = focusedIndex !== -1 ? focusedIndex : activeIndex === -1 ? 0 : activeIndex;
    // Inside a toolbar the group is one item of the row: Left/Right past its
    // edge belong to the toolbar, which moves on to the neighbouring control
    // rather than wrapping back round the group. Up/Down still wrap.
    const inToolbar = containerRef.current?.parentElement?.closest('[role="toolbar"]') != null;
    let target: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = nextEnabled(from, 1);
        if (inToolbar && event.key === "ArrowRight" && target <= from) return;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = nextEnabled(from, -1);
        if (inToolbar && event.key === "ArrowLeft" && target >= from) return;
        break;
      case "Home":
        target = firstEnabled;
        break;
      case "End":
        target = nextEnabled(0, -1);
        break;
      default:
        return;
    }
    // Only once the key is known to belong to the group: cancelling earlier would
    // eat keys the surrounding form and the browser still have a use for.
    event.preventDefault();
    event.stopPropagation();
    select(target);
  };

  const thumbDimmed = disabled || activeOption?.disabled;

  return (
    <div
      ref={containerRef}
      className={cn(
        // Compact keeps its 24px footprint by giving the segments the full
        // height rather than padding the track: the thumb stays inset 2px, but
        // the target a pointer can hit is 24px tall, not 20.
        "relative isolate rounded-[var(--radius-md)] bg-surface-inset",
        density === "compact" ? "px-0.5" : "p-0.5",
        fullWidth ? "flex w-full" : "inline-flex shrink-0",
        className
      )}
      role="radiogroup"
      data-testid={testId}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid || undefined}
      onKeyDown={handleKeyDown}
    >
      {thumb && (
        <span
          data-slot="segmented-thumb"
          className={cn(
            "absolute top-0.5 bottom-0.5 left-0 z-0 rounded-[var(--radius-sm)] pointer-events-none",
            // Per docs/themes/interaction-state-recipes.md "Segmented Toggle Group Active
            // State": overlay-medium fill. The boundary is text-secondary, not
            // border-strong: border-strong measured 1.5–1.7:1 against the track in dark
            // and light themes, and the fill barely moves, so the selection leaned on
            // the label alone — under SC 1.4.11's 3:1 for a state indicator.
            "bg-overlay-medium border border-text-secondary shadow-[var(--theme-shadow-ambient)]",
            // forced-colors discards the fill and the ambient shadow, so the thumb says
            // "selected" with a system-coloured border. Not a Highlight *fill*: that
            // makes Chromium paint a backplate behind the label and the text vanishes.
            "forced-colors:border-[Highlight]",
            // Only the thumb's own geometry animates, and reduced motion drops
            // it entirely rather than shortening it.
            thumb.animate && !skipMotion && "transition-[translate,width] duration-150 ease-out",
            "motion-reduce:transition-none",
            // Unavailable is not unselected: a disabled checked segment keeps its
            // thumb, dimmed with it.
            thumbDimmed && "opacity-40"
          )}
          style={{ translate: `${thumb.left}px 0`, width: thumb.width }}
          aria-hidden="true"
        />
      )}
      {options.map((option, index) => {
        const isActive = option.value === value;
        const isDisabled = disabled || option.disabled;
        const segment = (
          <button
            key={option.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={option.ariaLabel}
            data-testid={testId ? `${testId}-${option.value}` : undefined}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => pick(option.value)}
            disabled={isDisabled}
            className={cn(
              // The button is already a stacking context (z-10), so dimming it
              // cannot trap its label under a thumb sliding in from a sibling.
              "relative z-10 min-w-0 text-xs font-medium rounded-[var(--radius-sm)]",
              density === "compact" ? "px-2 py-1" : "px-2.5 py-1",
              fullWidth && "flex-1",
              "transition-colors duration-150 ease-out",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-1",
              "disabled:cursor-not-allowed disabled:pointer-events-none",
              isActive ? "text-text-primary" : "text-text-secondary hover:text-text-primary",
              // Belt and braces: if the thumb could not be measured, the checked
              // segment still has to look checked. A brighter label alone is not a
              // selected state.
              isActive &&
                !thumb &&
                "bg-overlay-medium border border-text-secondary forced-colors:border-[Highlight]",
              isDisabled && "opacity-40"
            )}
          >
            {/* `block truncate`: an inline label has no width of its own to
                overflow, so a shrinking segment would clip it mid-glyph instead
                of ellipsing it. */}
            <span className="block truncate">{option.label}</span>
          </button>
        );
        if (option.tooltip === undefined) return segment;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>{segment}</TooltipTrigger>
            <TooltipContent side="bottom">{option.tooltip}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
