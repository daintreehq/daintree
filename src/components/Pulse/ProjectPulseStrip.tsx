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
 * The collapsed strip renders whatever pulse is already cached but never
 * triggers a fetch itself — the git-log scan only runs when the user expands,
 * so simply landing on an empty grid costs nothing. Expanding kicks a fetch
 * (deduped/TTL-gated in the store) so the peek is fresh and the card opens on a
 * skeleton rather than a blank first frame.
 */
export function ProjectPulseStrip({ worktreeId }: ProjectPulseStripProps) {
  const [expanded, setExpanded] = useState(false);
  // getPulse returns the store's cached object (stable ref until it changes),
  // so a plain selector is churn-free — no useShallow needed. fetchPulse is a
  // stable store action.
  const pulse = usePulseStore((state) => state.getPulse(worktreeId));
  const fetchPulse = usePulseStore((state) => state.fetchPulse);

  const stripButtonRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  // Only move focus on a user-driven toggle — never grab focus on first mount
  // (the empty grid must not steal focus just by rendering).
  const toggledRef = useRef(false);

  useEffect(() => {
    if (!toggledRef.current) return;
    if (expanded) collapseButtonRef.current?.focus();
    else stripButtonRef.current?.focus();
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
    // is set synchronously) and the peek reflects the latest commits.
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
        <ProjectPulseCard worktreeId={worktreeId} />
        <button
          ref={collapseButtonRef}
          type="button"
          onClick={collapse}
          className="inline-flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text/50 transition-colors hover:text-daintree-text/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
          aria-expanded={true}
        >
          <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          Collapse
        </button>
      </div>
    );
  }

  const hasStreak = (pulse?.currentStreakDays ?? 0) > 1;
  // Expose the peeked stats to assistive tech — the visible commit/streak text
  // lives in aria-hidden decorative spans, so fold it into the button's name.
  const activityLabel = pulse
    ? `Show project activity — ${pulse.commitsInRange} commit${
        pulse.commitsInRange !== 1 ? "s" : ""
      }${hasStreak ? `, ${pulse.currentStreakDays} day streak` : ""}`
    : "Show project activity";

  return (
    <button
      ref={stripButtonRef}
      type="button"
      onClick={expand}
      aria-expanded={false}
      aria-label={activityLabel}
      className="group flex w-full max-w-lg items-center gap-3 rounded-[var(--radius-md)] border border-border-subtle/60 px-3 py-2 text-left transition-colors hover:bg-overlay-subtle focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
    >
      <Activity className="h-3.5 w-3.5 shrink-0 text-status-success/70" aria-hidden="true" />
      <span className="shrink-0 text-xs font-medium text-daintree-text/70">Project pulse</span>
      {pulse && miniCells.length > 0 && <MiniRibbon cells={miniCells} />}
      <span className="ml-auto flex shrink-0 items-center gap-2.5">
        {pulse ? (
          <>
            <span className="font-mono text-xs text-daintree-text/50">
              {pulse.commitsInRange} commit{pulse.commitsInRange !== 1 ? "s" : ""}
            </span>
            {hasStreak && (
              <span className="flex items-center gap-1 font-mono text-xs text-daintree-text/70">
                <StreakFlame streakDays={pulse.currentStreakDays!} size={12} />
                {pulse.currentStreakDays}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-daintree-text/40">View activity</span>
        )}
        <ChevronDown
          className="h-4 w-4 text-daintree-text/40 transition-colors group-hover:text-daintree-text/70"
          aria-hidden="true"
        />
      </span>
    </button>
  );
}
