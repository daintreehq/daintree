import { useCallback, useRef } from "react";
import type { ComponentType, KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { BAND_GLYPH } from "./PilotRunState";
import {
  bandFilterHasDemand,
  PILOT_BAND_FILTER_LABEL,
  PILOT_BAND_FILTERS,
  type PilotBandFilter,
  type PilotBandFilterCounts,
} from "./pilotRows";
import type { FleetBandCounts } from "@/lib/fleetAttention";

/** The tone a segment falls back to when it holds no demand. */
const NEUTRAL_TONE = "text-text-secondary";
const NEUTRAL_TONE_FADED = "text-text-secondary/40";

/**
 * Tone per segment, in complete class literals.
 *
 * Assembled strings like `${color}/40` are invisible to Tailwind's scanner, so
 * the faded variant is spelled out rather than derived — the same constraint
 * `QuickStateFilterBar` documents.
 *
 * `working` and `quiet` are hued unconditionally — see `segmentIsHued`. The
 * others carry the hue of the demand they can reveal, and only while they are
 * actually holding one; see `bandFilterHasDemand`. A mixed segment's glyph is
 * resolved at render time by `segmentVisual`, not read straight from here.
 */
interface SegmentVisual {
  Icon: ComponentType<{ className?: string }> | null;
  tone: string;
  toneFaded: string;
}

const SEGMENT_TONE: Record<Exclude<PilotBandFilter, "all">, SegmentVisual> = {
  "needs-you": {
    Icon: BAND_GLYPH["needs-you"],
    tone: "text-state-waiting",
    toneFaded: "text-state-waiting/40",
  },
  // The working mark in the waiting hue, and static — the same pairing the row
  // draws, because a silent run is a working run that may need a hand. No new
  // glyph: the spinner means working everywhere in this app and does not stop
  // meaning it here.
  quiet: {
    Icon: BAND_GLYPH.quiet,
    tone: "text-state-waiting",
    toneFaded: "text-state-waiting/40",
  },
  working: {
    Icon: BAND_GLYPH.running,
    tone: "text-state-working",
    toneFaded: "text-state-working/40",
  },
  finished: {
    Icon: BAND_GLYPH.review,
    tone: "text-category-blue",
    toneFaded: "text-category-blue/40",
  },
  // Parked never earns a hue: it is the user's own silence, and a coloured
  // segment would re-demand the attention parking just released.
  parked: {
    Icon: BAND_GLYPH.parked,
    tone: NEUTRAL_TONE,
    toneFaded: NEUTRAL_TONE_FADED,
  },
  // No glyph at all. "Other" holds a snooze and an exited shell, which share
  // nothing but their absence from the four questions this bar asks — any mark
  // would have to stand for one of them and misdescribe the rest. It exists so
  // the counts add up to All, and it is drawn as quietly as that job allows.
  other: {
    Icon: null,
    tone: NEUTRAL_TONE,
    toneFaded: NEUTRAL_TONE_FADED,
  },
};

/**
 * Whether a segment gets its configured hue or falls back to neutral.
 *
 * `working` is exempt from the demand test rather than failing it. A working
 * agent is genuinely not a demand — `bandFilterHasDemand` is right to report
 * false for `running` — but green for working is the vocabulary the sidebar,
 * the assistant header and the panel chrome already speak, and the segment has
 * to match the row glyphs it filters to. Every other segment earns its hue only
 * while it actually holds something to act on.
 */
function segmentIsHued(
  bands: Readonly<FleetBandCounts>,
  segment: Exclude<PilotBandFilter, "all">
): boolean {
  // `quiet` joins `working` in the exemption for the mirror-image reason: it
  // is not a demand either — nobody is asking — but a run that has gone silent
  // is a live fact about the fleet, which is exactly what this surface hues.
  // The empty-bucket fade below still mutes it when it holds nothing.
  return segment === "working" || segment === "quiet" || bandFilterHasDemand(bands, segment);
}

/**
 * The glyph a mixed segment wears, which is the band it is currently ABOUT.
 *
 * "Attention" admits `blocked` as well as `needs-you`, and drawing it with the
 * amber hollow circle while it held an errored run said the calmer of the two
 * things it was holding. A segment whose glyph never moves can only ever
 * describe one of its members.
 *
 * Only `needs-you` escalates, and only because it has somewhere to escalate
 * TO: `blocked` has a mark of its own. `finished` holds `review` and `done`,
 * which are the same app-standard check circle at two tones — that mark is not
 * this surface's to reinterpret, so its distinction rides the hue
 * (`bandFilterHasDemand` already owns that) and, for anyone the hue cannot
 * reach, `segmentQualifier` below puts it into the segment's spoken name.
 *
 * Escalation is also why the first segment could not stay called "Waiting": a
 * red prohibition sign beside that word contradicted itself, where beside
 * "Attention" it reads correctly — two runs want you, and the worse of them is
 * blocked. The accessible name says the same thing in words.
 */
function segmentVisual(
  bands: Readonly<FleetBandCounts>,
  segment: Exclude<PilotBandFilter, "all">
): SegmentVisual {
  if (segment === "needs-you" && bands.blocked > 0) {
    return {
      Icon: BAND_GLYPH.blocked,
      tone: "text-status-danger",
      toneFaded: "text-status-danger/40",
    };
  }
  return SEGMENT_TONE[segment];
}

/**
 * The part of a mixed segment its glyph encodes, in words.
 *
 * Colour and shape carry it visually; this is the same fact in the channel a
 * screen reader can reach. Null for a segment holding one kind of thing, so a
 * pure bucket is never padded with a clause that adds nothing.
 */
function segmentQualifier(
  bands: Readonly<FleetBandCounts>,
  segment: PilotBandFilter
): string | null {
  if (segment === "needs-you" && bands.blocked > 0) return `including ${bands.blocked} blocked`;
  if (segment === "finished" && bands.review > 0) {
    // "all", not "including", when the bucket is pure. Qualifying only the
    // MIXED case left a segment holding three hand-backs and one holding three
    // acknowledged completions with the same accessible name — the glyph tells
    // them apart, and a glyph is not a channel a screen reader can reach.
    return bands.done > 0 ? `including ${bands.review} ready for review` : `all ready for review`;
  }
  return null;
}

const SEGMENTS: readonly PilotBandFilter[] = ["all", ...PILOT_BAND_FILTERS];

function agents(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"}`;
}

/** A segment's spoken name, carrying whatever its glyph choice encodes. */
function segmentName(label: string, count: number, qualifier: string | null): string {
  const base = `${label}, ${agents(count)}`;
  return qualifier === null ? base : `${base}, ${qualifier}`;
}

export interface PilotFilterBarProps {
  value: PilotBandFilter;
  /** Rows per segment in the query-filtered fleet, so a count matches the list. */
  counts: Readonly<PilotBandFilterCounts>;
  /**
   * Per-band counts over the same population, which is what decides whether a
   * mixed segment has earned its hue. A count alone can't: "Finished" holding
   * three acknowledged runs and "Finished" holding three waiting to be reviewed
   * are the same number and opposite situations.
   */
  bands: Readonly<FleetBandCounts>;
  onChange: (value: PilotBandFilter) => void;
  /**
   * Fired as real focus enters and leaves the bar, so the palette can stop
   * advertising the list's keys while they belong to these segments instead.
   */
  onFocusChange?: (focused: boolean) => void;
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
 * Home/End as structural keys, but only while focus is physically in the
 * input, so the two never contend.
 *
 * Selection follows focus, per the radiogroup pattern: the filter is instant
 * and reversible, so making the user arrow then confirm would charge two
 * keystrokes for a decision they can see the result of.
 */
export function PilotFilterBar({
  value,
  counts,
  bands,
  onChange,
  onFocusChange,
}: PilotFilterBarProps) {
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
      onFocus={() => onFocusChange?.(true)}
      // Arrowing between segments blurs one and focuses the next, so a bare
      // handler would report the bar as vacated for a moment on every keypress.
      // Only a move that leaves the group entirely counts as leaving it.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange?.(false);
      }}
      className="flex"
    >
      {SEGMENTS.map((segment, idx) => {
        const isActive = segment === value;
        const count = counts[segment];
        const visual = segment === "all" ? null : segmentVisual(bands, segment);
        const label = PILOT_BAND_FILTER_LABEL[segment];
        const Icon = visual?.Icon;
        const isSpinning = segment === "working" && count > 0;
        const qualifier = segmentQualifier(bands, segment);
        const isHued = segment !== "all" && segmentIsHued(bands, segment);
        const tone = isHued ? visual?.tone : NEUTRAL_TONE;
        // An empty bucket keeps its glyph and its "0" but mutes the glyph, so
        // the zero registers without having to be read.
        const fadedTone = isHued ? visual?.toneFaded : NEUTRAL_TONE_FADED;

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
            // What the glyph encodes is named, not left in the drawing. A
            // segment that escalates to the danger mark and then announces a
            // flat "Needs you, 2 agents" has put the worse half of what it
            // holds into a channel a screen reader cannot reach.
            aria-label={segmentName(label, count, qualifier)}
            ref={(el) => {
              refs.current.set(segment, el);
            }}
            onClick={() => {
              onChange(segment);
            }}
            className={cn(
              // `grow`, not `flex-1`: a zero basis divides the bar into equal
              // shares, and seven equal shares of a 608px palette truncated
              // "Needs you" and "Finished" into "Need…" and "Finis…". Sizing
              // from content and sharing only the SLACK keeps every label whole
              // and still fills the bar edge to edge.
              "inline-flex min-w-0 grow items-center justify-center gap-1 px-1.5 py-1.5 transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
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
                  count === 0 ? fadedTone : tone,
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
                isActive ? "font-medium text-text-primary" : "text-daintree-text/60"
              )}
            >
              {label}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "text-xs tabular-nums",
                isActive ? "text-text-primary" : "text-daintree-text/60"
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
