import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { HeatCell } from "@shared/types";
import { usePulseStore } from "@/store";
import { Activity } from "@/components/icons";
import { ProjectPulseCard } from "./ProjectPulseCard";
import { getPulseHeatLevelBackground } from "./PulseHeatmap";
import { StreakFlame } from "./StreakFlame";

interface ProjectPulseStripProps {
  worktreeId: string;
}

// A short ribbon peek — just enough recent days to read momentum at a glance
// without competing with the launcher above it.
const MINI_CELLS = 18;
const MINI_CELL_PX = 6;
const MINI_GAP_PX = 2;

function MiniRibbon({ cells }: { cells: HeatCell[] }) {
  return (
    <div
      className="flex items-center"
      style={{ gap: `${MINI_GAP_PX}px` }}
      aria-hidden="true"
      data-testid="pulse-mini-ribbon"
    >
      {cells.map((cell) => (
        <span
          key={cell.date}
          className="rounded-[1px] shrink-0"
          style={{
            width: MINI_CELL_PX,
            height: MINI_CELL_PX,
            background: getPulseHeatLevelBackground(cell.level),
          }}
        />
      ))}
    </div>
  );
}

/**
 * The empty grid's pulse presence: a quiet one-line strip by default that
 * expands to the full {@link ProjectPulseCard} on click, and collapses again —
 * "click to quickly peek", never a permanent dashboard. Expansion is ephemeral
 * (resets to collapsed each mount) by design, so the launcher stays the focus.
 *
 * The strip populates itself on load: a cold cache kicks one pulse fetch on
 * mount so the ribbon/stat/flame peek is there from the first frame instead of
 * hiding behind a first expand. That fetch is a bounded git-log scan — deduped
 * in the store while in flight and cheap on repeat (the service caches under a
 * 60s TTL behind a HEAD probe). Expanding kicks another (deduped) fetch to
 * refresh the peek and open the card on a skeleton rather than a blank frame.
 */
export function ProjectPulseStrip({ worktreeId }: ProjectPulseStripProps) {
  const [expanded, setExpanded] = useState(false);
  // getPulse returns the store's cached object (stable ref until it changes),
  // so a plain selector is churn-free — no useShallow needed. fetchPulse is a
  // stable store action.
  const pulse = usePulseStore((state) => state.getPulse(worktreeId));
  const isLoading = usePulseStore((state) => state.isLoading(worktreeId));
  const error = usePulseStore((state) => state.getError(worktreeId));
  const fetchPulse = usePulseStore((state) => state.fetchPulse);

  const stripButtonRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  // Only move focus on a user-driven toggle — never grab focus on first mount
  // (the empty grid must not steal focus just by rendering).
  const toggledRef = useRef(false);

  // Populate the collapsed strip on load. A fresh empty grid has no cached
  // pulse, so kick one fetch on mount — but only when nothing has been
  // attempted yet. getError is a tri-state: undefined = never fetched, a
  // string = a real error (the store self-retries with backoff), and null =
  // the deliberate "no commits" outcome. Guard on `error === undefined`, not
  // `!error`: a settled null would otherwise keep passing the guard and, since
  // this effect is the fetch trigger, spin a tight refetch loop. The store also
  // dedupes in-flight requests, so a later expand collapses onto this one.
  useEffect(() => {
    if (!pulse && !isLoading && error === undefined) {
      void fetchPulse(worktreeId);
    }
  }, [worktreeId, pulse, isLoading, error, fetchPulse]);

  // Move focus into the expansion without moving the viewport at all. The
  // collapse control is rendered at the TOP of the expansion, exactly where
  // the strip the user just clicked was standing, so it is already on screen
  // and `preventScroll` costs nothing: no scrollIntoView is needed, and none
  // is wanted. The earlier arrangement put the control at the card's bottom,
  // several hundred pixels down, and any attempt to reveal it dragged the
  // project identity and the launch anchor off the top of the canvas —
  // expanding the lowest-priority band on the surface must not cost the user
  // the thing they came here to click.
  useEffect(() => {
    if (!toggledRef.current) return;
    if (expanded) collapseButtonRef.current?.focus({ preventScroll: true });
    else stripButtonRef.current?.focus({ preventScroll: true });
  }, [expanded]);

  const miniCells = useMemo(() => {
    if (!pulse) return [];
    return [...pulse.heatmap]
      .filter((cell) => !cell.isBeforeProject && !Number.isNaN(new Date(cell.date).getTime()))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(-MINI_CELLS);
  }, [pulse]);

  const expand = () => {
    toggledRef.current = true;
    // Kick a fetch before mounting the card so it opens on a skeleton (loading
    // is set synchronously) and the peek reflects the latest activity.
    void fetchPulse(worktreeId);
    setExpanded(true);
  };
  const collapse = () => {
    toggledRef.current = true;
    setExpanded(false);
  };

  if (expanded) {
    return (
      <div className="flex w-full flex-col items-center gap-2">
        <button
          ref={collapseButtonRef}
          type="button"
          onClick={collapse}
          className="inline-flex items-center gap-1 self-start rounded-[var(--radius-md)] px-2 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
          aria-expanded={true}
        >
          <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          Collapse
        </button>
        <ProjectPulseCard worktreeId={worktreeId} />
      </div>
    );
  }

  const hasStreak = (pulse?.currentStreakDays ?? 0) > 1;
  // The button's explicit aria-label overrides its descendant text for the
  // accessible name, so fold the visible active-days/streak peek into it —
  // otherwise assistive tech hears only "Show project activity".
  const activityLabel = pulse
    ? `Show project activity — ${pulse.activeDays} active day${
        pulse.activeDays !== 1 ? "s" : ""
      }${hasStreak ? `, ${pulse.currentStreakDays} day streak` : ""}`
    : "Show project activity";

  return (
    <button
      ref={stripButtonRef}
      type="button"
      onClick={expand}
      aria-expanded={false}
      aria-label={activityLabel}
      className="group flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-border-subtle px-3 py-2 text-left transition-colors hover:bg-overlay-subtle focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
    >
      <Activity className="h-3.5 w-3.5 shrink-0 text-status-success/70" aria-hidden="true" />
      <span className="shrink-0 text-xs font-medium text-text-secondary">Project pulse</span>
      {pulse && miniCells.length > 0 && <MiniRibbon cells={miniCells} />}
      <span className="ml-auto flex shrink-0 items-center gap-2.5">
        {pulse ? (
          <>
            <span className="font-mono text-xs text-text-secondary">
              {pulse.activeDays} active day{pulse.activeDays !== 1 ? "s" : ""}
            </span>
            {hasStreak && (
              <span className="flex items-center gap-1 font-mono text-xs text-daintree-text/70">
                <StreakFlame streakDays={pulse.currentStreakDays!} size={12} />
                {pulse.currentStreakDays}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-text-secondary">View activity</span>
        )}
        <ChevronDown
          className="h-4 w-4 text-text-secondary transition-colors group-hover:text-text-primary"
          aria-hidden="true"
        />
      </span>
    </button>
  );
}
