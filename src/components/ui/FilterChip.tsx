import * as React from "react";
import { formatCountExact } from "@/lib/formatCount";
import { cn } from "@/lib/utils";

/**
 * The app's one filter chip: a pill in a set that narrows a list by value
 * (worktree facets, inbox filters, plugin categories, log levels, event
 * categories, event context values). A control that switches a mode rather than
 * narrowing a list is a toggle — `Button` with `pressed` — not a chip.
 *
 *   unavailable — matches nothing right now. Shows its `(0)` and drops to the
 *     quiet edge, so the values that would narrow the list are the ones that
 *     stand out. Still clickable: its count is what answers "will this do
 *     anything", and disabling it would take it out of the tab order while
 *     another facet can bring it back.
 *   available   — a subtle fill gives the pill a body; the edge alone is far
 *     below a perceptible step on every dark theme.
 *   selected    — the strong filter fill, `font-medium` and primary ink over the
 *     same `text-secondary` edge (3:1 in both polarities). `font-medium` is the
 *     part that carries selection, and it is not decoration: hovering an
 *     available chip already raises its fill and its ink, so fill and tone alone
 *     rendered hover and selected identically. Weight is the one axis hover does
 *     not touch.
 *
 * No accent in any state: several chips can be selected at once, which is the
 * membership case the accent rule excludes.
 *
 * `data-filter-chip` is the hook the `forced-colors` block in `index.css`
 * redraws the selected chip from: forced colours flattens the fill to Canvas,
 * so without it every chip arrives as the same outlined pill. Increased
 * contrast needs no rule of its own — author colours survive there, and every
 * state already carries an edge.
 */
export interface FilterChipProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "aria-pressed"
> {
  selected: boolean;
  /** Matches for this value. `0` on an unselected chip marks it unavailable. */
  count?: number;
}

export const FilterChip = React.forwardRef<HTMLButtonElement, FilterChipProps>(
  ({ selected, count, className, children, ...props }, ref) => {
    const unavailable = count === 0 && !selected;
    return (
      <button
        ref={ref}
        type="button"
        aria-pressed={selected}
        data-filter-chip="true"
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs whitespace-nowrap transition-colors duration-150 ease-out",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
          selected
            ? "border-text-secondary bg-filter-selected-bg-strong font-medium text-text-primary"
            : unavailable
              ? "border-border-default bg-transparent text-text-secondary hover:text-text-primary"
              : "border-text-secondary bg-overlay-soft text-text-secondary hover:bg-overlay-medium hover:text-text-primary",
          className
        )}
        {...props}
      >
        {children}
        {/* The space is for the accessible name ("Dirty (3)"); the flex gap
            already spaces the pixels, so it renders nothing. Exact and
            grouped, "(2,172)": the count answers how many a filter keeps. */}
        {count !== undefined && (
          <>
            {" "}
            <span className="tabular-nums">({formatCountExact(count)})</span>
          </>
        )}
      </button>
    );
  }
);
FilterChip.displayName = "FilterChip";
