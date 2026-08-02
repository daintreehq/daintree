import { useCallback, useRef } from "react";
import type { ComponentType, KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { BAND_GLYPH } from "./PilotRunState";
import {
  PILOT_BAND_FILTER_LABEL,
  PILOT_BAND_FILTERS,
  type PilotBandFilter,
  type PilotBandFilterCounts,
} from "./pilotRows";

/**
 * Tone per segment, in complete class literals.
 *
 * Assembled strings like `${color}/40` are invisible to Tailwind's scanner, so
 * the faded variant is spelled out rather than derived — the same constraint
 * `QuickStateFilterBar` documents.
 *
 * `working` is neutral because its rows are: colour is spent only where there
 * is a demand, and a hued Working segment would put back one of the competing
 * signals this surface exists to remove. The other two keep the hue of the
 * worst band they admit, which is what ties a segment to the rows it reveals.
 */
const SEGMENT_TONE: Record<
  Exclude<PilotBandFilter, "all">,
  { Icon: ComponentType<{ className?: string }>; tone: string; toneFaded: string }
> = {
  "needs-you": {
    Icon: BAND_GLYPH["needs-you"],
    tone: "text-state-waiting",
    toneFaded: "text-state-waiting/40",
  },
  working: {
    Icon: BAND_GLYPH.running,
    tone: "text-text-secondary",
    toneFaded: "text-text-secondary/40",
  },
  finished: {
    Icon: BAND_GLYPH.review,
    tone: "text-activity-completed",
    toneFaded: "text-activity-completed/40",
  },
};

const SEGMENTS: readonly PilotBandFilter[] = ["all", ...PILOT_BAND_FILTERS];

export interface PilotFilterBarProps {
  value: PilotBandFilter;
  /** Rows per segment in the query-filtered fleet, so a count matches the list. */
  counts: Readonly<PilotBandFilterCounts>;
  onChange: (value: PilotBandFilter) => void;
}

/**
 * The state filter under the search box.
 *
 * A radiogroup rather than the worktree sidebar's toolbar-of-toggles: these
 * segments are mutually exclusive with All as the null option, which is what a
 * radiogroup IS. (The sidebar's own `QuickStateFilterBar` is roled as a toolbar
 * with `aria-pressed` for the same single-select behaviour, which is arguably
 * wrong, but realigning it is a separate change.) Visually the two are the same
 * control — same segment box, dividers, active treatment and
 * muted-icon-on-zero rule — so the fleet overview and the sidebar don't teach
 * two spellings of one idea.
 *
 * Physical focus lives in the search input, which drives the list through
 * `aria-activedescendant`; Tab hands real focus to this bar, and from that
 * moment the input's virtual focus is simply inert rather than contradicted.
 * Arrow keys are bound HERE and nowhere else — `usePaletteTreeNavigation` owns
 * Home/End/←/→ as structural keys, but only while focus is physically in the
 * input, so the two never contend.
 *
 * Selection follows focus, per the radiogroup pattern: the filter is instant
 * and reversible, so making the user arrow then confirm would charge two
 * keystrokes for a decision they can see the result of.
 */
export function PilotFilterBar({ value, counts, onChange }: PilotFilterBarProps) {
  const refs = useRef(new Map<PilotBandFilter, HTMLButtonElement | null>());

  const move = useCallback(
    (to: PilotBandFilter) => {
      onChange(to);
      refs.current.get(to)?.focus();
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = SEGMENTS.indexOf(value);
      if (index === -1) return;

      let next: PilotBandFilter | undefined;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          next = SEGMENTS[(index + 1) % SEGMENTS.length];
          break;
        case "ArrowLeft":
        case "ArrowUp":
          next = SEGMENTS[(index - 1 + SEGMENTS.length) % SEGMENTS.length];
          break;
        case "Home":
          next = SEGMENTS[0];
          break;
        case "End":
          next = SEGMENTS[SEGMENTS.length - 1];
          break;
        default:
          return;
      }

      if (next === undefined) return;
      // Only once a key is known to belong to this bar. Cancelling earlier
      // would eat keys the dialog and the browser still have a use for.
      event.preventDefault();
      event.stopPropagation();
      move(next);
    },
    [value, move]
  );

  return (
    <div
      role="radiogroup"
      aria-label="Filter agents by state"
      data-testid="pilot-filter-bar"
      onKeyDown={handleKeyDown}
      className="flex"
    >
      {SEGMENTS.map((segment, idx) => {
        const isActive = segment === value;
        const count = counts[segment];
        const visual = segment === "all" ? null : SEGMENT_TONE[segment];
        const label = PILOT_BAND_FILTER_LABEL[segment];
        // An empty bucket keeps its glyph and its "0" but mutes the glyph, so
        // the zero registers without having to be read.
        const Icon = visual?.Icon;
        const isSpinning = segment === "working" && count > 0;

        return (
          <button
            key={segment}
            type="button"
            role="radio"
            aria-checked={isActive}
            // Roving tabindex: the checked segment is the bar's single tab
            // stop, so Tab from the search box lands on the active filter
            // rather than walking four controls to reach the list.
            tabIndex={isActive ? 0 : -1}
            aria-label={`${label}, ${count} ${count === 1 ? "agent" : "agents"}`}
            ref={(el) => {
              refs.current.set(segment, el);
            }}
            onClick={() => {
              onChange(segment);
            }}
            className={cn(
              "inline-flex min-w-0 flex-1 items-center justify-center gap-1 px-2 py-1.5 transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent",
              idx > 0 && "border-l border-border-default",
              isActive
                ? // Fallback keeps themes without the var byte-identical.
                  "bg-[var(--worktree-quick-state-active-bg,var(--color-overlay-subtle))] shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                : "hover:bg-tint/[0.04]"
            )}
          >
            {Icon && visual && (
              <Icon
                aria-hidden="true"
                className={cn(
                  "h-3 w-3 shrink-0 transition-colors",
                  count === 0 ? visual.toneFaded : visual.tone,
                  isSpinning && "animate-spin-slow motion-reduce:animate-none"
                )}
              />
            )}
            {/* The accessible name above carries both halves; exposing them
                again would read the segment twice. */}
            <span
              aria-hidden="true"
              className={cn(
                "truncate text-xs",
                isActive ? "font-medium text-daintree-text" : "text-daintree-text/60"
              )}
            >
              {label}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "text-xs tabular-nums",
                isActive ? "text-daintree-text" : "text-daintree-text/60"
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
