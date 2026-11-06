import { useCallback, useId, useMemo, useRef, useState } from "react";
import { suppressShiftClickTextSelection } from "@/utils/shiftClickSelection";
import type React from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { PtyPanelData } from "@shared/types/panel";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { cn } from "@/lib/utils";
import type { WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import { getAgentConfig } from "@/config/agents";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  SESSION_ICONS,
  SESSION_COLORS,
  SESSION_LABELS,
  summarizeSessionStates,
} from "../terminalStateConfig";
import { useRunSessionPresentation } from "@/hooks/useRunSessionPresentation";
import { useRunParkState } from "@/hooks/useRunParkState";
import { ParkedCircle } from "@/components/icons";
import { useRunCanopyPlacement } from "@/hooks/useRunCanopyPlacement";
import { useWallClock } from "@/hooks/useWallClock";
import { canopyEvidenceParts } from "@/lib/canopyRefinementPresentation";
import type { RunCanopyRefinement } from "@shared/types/ipc/fleet";
import { CollapsedSessionIndicators } from "./CollapsedSessionIndicators";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import {
  ChevronRight,
  GripVertical,
  PanelBottom,
  PanelTopClose,
  Plus,
  SquareTerminal,
} from "lucide-react";
import { DRAG_GRIP_CLASS, DRAG_GRIP_ICON_CLASS } from "@/components/ui/dragGripStyles";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { DismissButton } from "@/components/ui/DismissButton";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { useKeybindingScope } from "@/hooks/useKeybinding";
import {
  SECTION_LABEL,
  CARD_DENSITY,
  DISCLOSURE_BUTTON,
  DISCLOSURE_BUTTON_LABELLED,
  INLINE_SESSIONS_SLOT,
} from "./sectionChrome";
import { pluralize } from "@/lib/pluralize";

interface MarqueeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TerminalRowProps {
  term: PtyPanelData;
  onClick: (term: PtyPanelData) => void;
  /** Enter on an armable row opens its session rather than arming it. */
  onOpen?: (term: PtyPanelData) => void;
  /** Vertical padding of the row's button — `CardDensity.sessionRowY`. */
  padY: string;
  /** See {@link WorktreeTerminalSectionProps.rowClick}. */
  canArm: boolean;
}

/** How often a Canopy attribution re-reads the clock: its age is in minutes. */
const EVIDENCE_TICK_MS = 30_000;
const nextEvidenceTick = () => EVIDENCE_TICK_MS;

interface CanopyEvidenceLineProps {
  refinement: RunCanopyRefinement;
  id: string;
  pointer: Pick<React.HTMLAttributes<HTMLElement>, "onPointerEnter" | "onPointerLeave">;
}

/**
 * What Canopy read that moved this session into its bucket, quoted and
 * attributed, under the title. The glyph beside it keeps showing what Daintree
 * observed: a reading sits alongside the observation and never replaces it.
 */
function CanopyEvidenceLine({ refinement, id, pointer }: CanopyEvidenceLineProps) {
  const now = useWallClock(refinement.readAt, nextEvidenceTick);
  const { claim, attribution } = canopyEvidenceParts(refinement, now);
  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <span
          id={id}
          data-canopy-evidence={refinement.kind}
          className="flex min-w-0 items-baseline gap-1 text-2xs text-text-secondary"
          {...pointer}
        >
          {/* The quote truncates; who read it never does. */}
          <span className="min-w-0 truncate">{claim}</span>
          <span className="shrink-0">· {attribution}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {claim} · {attribution}
      </TooltipContent>
    </Tooltip>
  );
}

function TerminalRow({ term, onClick, onOpen, padY, canArm }: TerminalRowProps) {
  const { ref, isTruncated } = useTruncationDetection();
  const dragHandle = useDragHandle();
  const isArmed = useFleetArmingStore((s) => s.armedIds.has(term.id));
  const armBadge = useFleetArmingStore((s) => s.armOrderById[term.id]);
  const chrome = deriveTerminalChrome(term);
  // Mirror the panel-level `data-agent-state` attribute: only surface the
  // agent state while the chrome is rendering an agent. Once the chrome
  // demotes back to a plain terminal (agent exited or never lived), there
  // is nothing for the sidebar row to track either.
  const agentState = getTerminalAgentDisplayState(chrome, term.agentState);
  // The glyph alone follows the run's fleet band, as the pane's does: the data
  // attribute keeps the observed state for E2E selectors.
  const glyphState = useRunSessionPresentation(term.id, agentState);
  // Parked is the user's own intent, not an observed state, so it rides beside
  // the state glyph rather than replacing it — and leaves the data attribute
  // alone.
  const park = useRunParkState(term.id);
  const canopy = useRunCanopyPlacement(term.id);
  // The primary ("last armed") row is the one keyboard focus returns to when
  // fleet scope exits; it is told apart by a solid outline against the peers'
  // dashed one, both neutral, since a persistent accent here sat beside the
  // active card's edge as a second "this one".
  const isPrimary = useFleetArmingStore((s) => s.lastArmedId === term.id);
  const isArmable = canArm && isFleetArmEligible(term);
  const StateIcon = glyphState ? SESSION_ICONS[glyphState] : null;
  const placementLabel = term.location === "dock" ? "Docked" : "On grid";
  const showCommand = !chrome.isAgent && term.activityStatus === "working" && !!term.lastCommand;
  // `useId`, not the terminal id: the sidebar card and the overview grid can
  // render the same session at once, and a shared id resolves to the wrong row.
  const idBase = useId();
  const titleId = `${idBase}-title`;
  const placementId = `${idBase}-placement`;
  const commandId = `${idBase}-command`;
  const evidenceId = `${idBase}-evidence`;
  const parkId = `${idBase}-park`;
  const stateId = `${idBase}-state`;
  // The metadata tooltips sit inside the title tooltip's trigger, so pointing
  // at one would otherwise open both.
  const [isOverMeta, setIsOverMeta] = useState(false);
  const metaPointer = {
    onPointerEnter: () => setIsOverMeta(true),
    onPointerLeave: () => setIsOverMeta(false),
  };

  // The session's own menu, not the worktree card's it sits inside.
  return (
    <TerminalContextMenu terminalId={term.id} proxy>
      <div
        data-terminal-id={term.id}
        data-terminal-runtime-kind={chrome.runtimeKind}
        data-terminal-agent-id={chrome.agentId || undefined}
        data-terminal-agent-state={agentState || undefined}
        data-session-row=""
        className={cn(
          "rounded-[var(--radius-lg)]",
          // 4px in, not 2: at 2 the stroke sat 1px inside the well's border and
          // met the next armed row's stroke edge to edge.
          isArmed && "outline outline-2 outline-offset-[-4px]",
          // Neutral, like the peers: armed is membership, and accent is the
          // sidebar's one "this one" (the active card's edge, or a focus ring).
          // Solid against the peers' dashed still says which is primary.
          isArmed && isPrimary && "outline-solid outline-text-secondary",
          isArmed && !isPrimary && "outline-dashed outline-border-strong"
        )}
      >
        {/* One row, the same height as the disclosure row that owns it. It used
          to be 40px against that row's 26 — 8px of padding around a 24px grip
          box — so two sessions spent more height than the rest of the card's
          body, and children read heavier than their parent.

          The grip lives in the leading gutter, which the row already spent on
          indentation: it lands under the trigger's chevron, and the agent
          glyph still lands under the trigger's label. Trailing, it was a
          fourth mark in a cluster of three, 34px of permanent chrome taken
          from the title. */}
        <div className="worktree-section-button group/termrow flex items-center rounded-[var(--radius-lg)] border border-transparent">
          <button
            ref={dragHandle?.setActivatorNodeRef}
            type="button"
            data-drag-handle
            data-session-grip=""
            className={DRAG_GRIP_CLASS}
            aria-label="Drag to move terminal"
            {...(dragHandle?.listeners as React.HTMLAttributes<HTMLElement> | undefined)}
          >
            <GripVertical className={DRAG_GRIP_ICON_CLASS} aria-hidden="true" />
          </button>

          <TruncatedTooltip content={term.title} isTruncated={isTruncated} disabled={isOverMeta}>
            {/* The whole rest of the row is the button, trailing marks
              included: the hover fill paints the full row, so the full row is
              what a click has to answer to. */}
            <button
              type="button"
              data-session-row-button=""
              onMouseDown={suppressShiftClickTextSelection}
              onClick={(e) => {
                e.stopPropagation();
                onClick(term);
              }}
              // A click arms (the fleet gesture); from the keyboard, Space
              // arms the same way and Enter opens the session, so there is a
              // key that reaches a waiting agent's pane, not only one that
              // adds it to a broadcast.
              onKeyDown={(e) => {
                if (!isArmable || e.key !== "Enter" || !onOpen) return;
                e.preventDefault();
                e.stopPropagation();
                onOpen(term);
              }}
              aria-pressed={isArmable ? isArmed : undefined}
              // Named by the title alone: the placement and command below are
              // descriptions, and as descendant text they would otherwise be
              // read twice and change the toggle's name whenever they change.
              aria-labelledby={titleId}
              aria-describedby={[
                StateIcon && glyphState ? stateId : null,
                showCommand ? commandId : null,
                canopy !== undefined ? evidenceId : null,
                park.parked ? parkId : null,
                placementId,
              ]
                .filter((id): id is string => id !== null)
                .join(" ")}
              className={cn(
                // The ring is drawn by a pseudo-element reaching back over the
                // grip's gutter, so it outlines the row rather than clipping the
                // agent glyph that starts this button.
                "relative flex min-w-0 flex-1 items-center gap-2 self-stretch pr-2.5 text-left cursor-pointer focus-visible:outline-hidden before:pointer-events-none before:absolute before:inset-y-0 before:-left-6 before:right-0 before:rounded-[var(--radius-lg)] focus-visible:before:outline focus-visible:before:outline-2 focus-visible:before:outline-accent-primary focus-visible:before:outline-offset-[-2px]",
                padY
              )}
            >
              <TerminalIcon kind={term.kind} chrome={chrome} className="w-3 h-3 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  ref={ref}
                  id={titleId}
                  className="truncate text-xs font-medium text-text-secondary transition-colors group-hover/termrow:text-text-primary group-has-[:focus-visible]/termrow:text-text-primary"
                >
                  {term.title}
                </span>
                {showCommand && (
                  <Tooltip autoDismiss={false}>
                    <TooltipTrigger asChild>
                      <span
                        id={commandId}
                        className="truncate text-2xs font-mono text-text-secondary"
                        {...metaPointer}
                      >
                        {term.lastCommand}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{term.lastCommand}</TooltipContent>
                  </Tooltip>
                )}
                {canopy !== undefined && (
                  <CanopyEvidenceLine refinement={canopy} id={evidenceId} pointer={metaPointer} />
                )}
              </span>

              <span className="flex shrink-0 items-center gap-1.5">
                {isArmed && armBadge !== undefined && (
                  <span
                    // Neutral: every armed row carries one, and accent is for the
                    // single focus anchor, which the primary row's outline marks.
                    className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-overlay-strong px-1 text-4xs font-mono font-semibold text-text-primary tabular-nums"
                    aria-label={`Armed position ${armBadge}`}
                  >
                    {armBadge}
                  </span>
                )}

                {park.parked && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="text-text-secondary"
                        data-testid="session-row-parked"
                        {...metaPointer}
                      >
                        <span id={parkId} className="sr-only">
                          {park.note !== null ? `Parked: ${park.note}` : "Parked"}
                        </span>
                        <ParkedCircle className="w-3 h-3" aria-hidden="true" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      {park.note !== null ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">Parked</span>
                          <span className="break-words">{park.note}</span>
                        </div>
                      ) : (
                        "Parked"
                      )}
                    </TooltipContent>
                  </Tooltip>
                )}

                {StateIcon && glyphState && (
                  <>
                    {/* The glyph is aria-hidden, so its label is never read: the
                        state rides the row's description instead. */}
                    <span id={stateId} className="sr-only">
                      {SESSION_LABELS[glyphState]}
                    </span>
                    <StateIcon
                      className={cn(
                        "w-3 h-3",
                        SESSION_COLORS[glyphState],
                        glyphState === "working" && "animate-spin-slow motion-reduce:animate-none"
                      )}
                      aria-label={SESSION_LABELS[glyphState]}
                    />
                  </>
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-text-secondary" {...metaPointer}>
                      <span id={placementId} className="sr-only">
                        {placementLabel}
                      </span>
                      {term.location === "dock" ? (
                        <PanelBottom className="w-3 h-3" aria-hidden="true" />
                      ) : (
                        <PanelTopClose className="w-3 h-3" aria-hidden="true" />
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{placementLabel}</TooltipContent>
                </Tooltip>
              </span>
            </button>
          </TruncatedTooltip>
        </div>
      </div>
    </TerminalContextMenu>
  );
}

export interface WorktreeTerminalSectionProps {
  worktreeId: string;
  /**
   * Opens the panel palette for this worktree. Drives the empty tray's row —
   * and the empty tray does not render without it. The tray presents itself as
   * a `Start a session` button, so a caller that cannot start a session gets
   * no tray rather than a focusable control that silently does nothing.
   * `DeletedWorktreeCard` is that caller: its worktree's directory is gone, so
   * there is nothing to start a session in.
   */
  onStartSession?: () => void;
  /** See {@link WorktreeDetailsSectionProps.variant} — same reasoning. */
  variant?: "sidebar" | "grid";
  isExpanded: boolean;
  counts: WorktreeTerminalCounts;
  terminals: PtyPanelData[];
  onToggle: (e: React.MouseEvent) => void;
  onTerminalSelect: (terminal: PtyPanelData) => void;
  /**
   * What clicking a row does. A live card's rows arm agents for a fleet
   * broadcast; a deleted worktree's rows only ever view, because opening one
   * is how you inspect a session before deciding whether to rescue it — and
   * the collapsed group's rail beside them already views on click.
   */
  rowClick?: "arm" | "select";
  /**
   * The trigger sits at the end of the Details row instead of on a row of its
   * own (compact sidebar card), and stays there once opened, with the list
   * laid out beneath that row.
   */
  inline?: boolean;
  /** Names the worktree in the disclosure's accessible name. */
  worktreeLabel?: string;
  /**
   * The caller draws the session-state glyphs on its own title row (the live
   * sidebar card), so the closed trigger leaves them out rather than repeat
   * them. A caller without such a row keeps them here.
   */
  stateGlyphsElsewhere?: boolean;
}

const FLEET_HINT_DISMISSED_KEY = "daintree:fleet-selection-hint-dismissed";

export function WorktreeTerminalSection({
  worktreeId,
  onStartSession,
  variant = "sidebar",
  isExpanded,
  counts,
  terminals,
  onToggle,
  onTerminalSelect,
  rowClick = "arm",
  inline = false,
  stateGlyphsElsewhere = false,
  worktreeLabel,
}: WorktreeTerminalSectionProps) {
  useKeybindingScope("worktreeGrid", isExpanded);

  const isSidebar = variant === "sidebar";
  const density = CARD_DENSITY[isSidebar ? "sidebar" : "grid"];
  const showMetaFooter = counts.total > 0;

  const terminalsId = `worktree-${worktreeId}-terminals`;
  const terminalsPanelId = `worktree-${worktreeId}-terminals-panel`;
  const summaryId = `${terminalsId}-summary`;
  const triggerName = worktreeLabel
    ? `Active sessions for worktree ${worktreeLabel}`
    : "Active sessions";

  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem(FLEET_HINT_DISMISSED_KEY) === "1"
  );
  const armedIdsSize = useFleetArmingStore((s) => s.armedIds.size);

  const { visibleTerminalStates, terminalSessionAriaLabel, collapsedTriggerLabel } = useMemo(() => {
    const { visibleStates, label, breakdown } = summarizeSessionStates(
      counts.byState,
      counts.total,
      counts.unread,
      counts.blocked
    );
    // The collapsed trigger names itself once. Left to name-from-content it
    // read "3 active 3 sessions: 2 working, …" — the visible summary, then
    // the cluster's own name repeating the total. Starts with the visible
    // "N active" so speech input can still target it by what is on screen.
    const triggerLabel = `${pluralize(counts.total, "active session")}${breakdown ? `: ${breakdown}` : ""}`;
    return {
      visibleTerminalStates: visibleStates,
      terminalSessionAriaLabel: label,
      collapsedTriggerLabel: triggerLabel,
    };
  }, [counts.byState, counts.total, counts.unread, counts.blocked]);

  const SummaryIcon = useMemo(() => {
    if (terminals.length === 0) return null;
    let commonId: string | null = null;
    for (const t of terminals) {
      const effectiveId = deriveTerminalChrome(t).agentId;
      if (!effectiveId) return null;
      if (commonId === null) commonId = effectiveId;
      else if (effectiveId !== commonId) return null;
    }
    if (!commonId) return null;
    return getAgentConfig(commonId)?.icon ?? null;
  }, [terminals]);

  const orderedWorktreeTerminals = terminals;
  // Empty in select mode, which takes the marquee and the fleet hint with it.
  const eligibleTerminals = useMemo(
    () => (rowClick === "arm" ? orderedWorktreeTerminals.filter(isFleetArmEligible) : []),
    [orderedWorktreeTerminals, rowClick]
  );

  const handleTerminalClick = useCallback(
    (term: PtyPanelData) => {
      if (rowClick === "select" || !isFleetArmEligible(term)) {
        onTerminalSelect(term);
        return;
      }
      // Shift, Cmd, Ctrl, and unmodified clicks all toggle membership —
      // the sidebar mirrors the grid's "Shift = single add" gesture so
      // the model is consistent across surfaces.
      useFleetArmingStore.getState().toggleId(term.id);
    },
    [onTerminalSelect, rowClick]
  );

  // Marquee starts potential on pointerdown (no capture yet). We only upgrade
  // to an active marquee — and take pointer capture — after the pointer has
  // moved past a small threshold. This way a plain click on a tile still
  // fires its onClick handler, while drag-to-select activates cleanly.
  const MARQUEE_THRESHOLD_PX = 4;
  const marqueeStartRef = useRef<{
    x: number;
    y: number;
    pointerId: number;
    active: boolean;
  } | null>(null);
  const tileRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<MarqueeBox | null>(null);

  const snapshotRects = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll<HTMLElement>("[data-terminal-id]");
    const rects = new Map<string, DOMRect>();
    nodes.forEach((el) => {
      const id = el.dataset.terminalId;
      if (id) rects.set(id, el.getBoundingClientRect());
    });
    tileRectsRef.current = rects;
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // The marquee arms rows; a select-only section has nothing for it to do.
      if (e.button !== 0 || rowClick !== "arm") return;
      const target = e.target as Element;
      // dnd-kit owns the drag handle — don't shadow its pointer events.
      if (target.closest("[data-drag-handle]")) return;
      marqueeStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        active: false,
      };
      snapshotRects();
    },
    [snapshotRects, rowClick]
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = marqueeStartRef.current;
    if (!start) return;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    if (!start.active) {
      if (dx < MARQUEE_THRESHOLD_PX && dy < MARQUEE_THRESHOLD_PX) return;
      start.active = true;
      try {
        e.currentTarget.setPointerCapture(start.pointerId);
      } catch {
        // capture may fail if pointer already released
      }
    }
    const container = scrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = Math.min(start.x, e.clientX) - rect.left + container.scrollLeft;
    const y = Math.min(start.y, e.clientY) - rect.top + container.scrollTop;
    setMarqueeBox({ x, y, w: dx, h: dy });
  }, []);

  const commitMarquee = useCallback(
    (endX: number, endY: number) => {
      const start = marqueeStartRef.current;
      if (!start) return;
      const left = Math.min(start.x, endX);
      const right = Math.max(start.x, endX);
      const top = Math.min(start.y, endY);
      const bottom = Math.max(start.y, endY);
      const hits: string[] = [];
      for (const [id, r] of tileRectsRef.current) {
        if (r.right < left || r.left > right || r.bottom < top || r.top > bottom) continue;
        hits.push(id);
      }
      if (hits.length > 0) {
        const eligible = new Set(eligibleTerminals.map((t) => t.id));
        const orderedHits = orderedWorktreeTerminals
          .map((t) => t.id)
          .filter((id) => hits.includes(id) && eligible.has(id));
        if (orderedHits.length > 0) {
          useFleetArmingStore.getState().armIds(orderedHits);
          localStorage.setItem(FLEET_HINT_DISMISSED_KEY, "1");
          setHintDismissed(true);
        }
      }
    },
    [orderedWorktreeTerminals, eligibleTerminals]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = marqueeStartRef.current;
      if (!start) return;
      if (start.active) {
        try {
          e.currentTarget.releasePointerCapture(start.pointerId);
        } catch {
          // capture may already be released
        }
        commitMarquee(e.clientX, e.clientY);
      }
      marqueeStartRef.current = null;
      setMarqueeBox(null);
    },
    [commitMarquee]
  );

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = marqueeStartRef.current;
    if (!start) return;
    if (start.active) {
      try {
        e.currentTarget.releasePointerCapture(start.pointerId);
      } catch {
        // ignore
      }
    }
    marqueeStartRef.current = null;
    setMarqueeBox(null);
  }, []);

  /* No sessions. The grid shows a quiet "Start a session" row: its cards sit
     side by side in rows, and a card with no bottom slot broke the row's
     baseline, and "no sessions" and "the sessions row did not render" looked
     the same. The row names the next action rather than the absence.

     The sidebar card drops it in both densities. Repeated down a long list
     it was the same call to action on every idle card, the quietest cards
     carrying an extra row, and the list's largest single share of height.
     Starting a session stays one step away in the card's menus. */
  if (!showMetaFooter) {
    // No tray without somewhere for its row to go: see `onStartSession`.
    if (!onStartSession || isSidebar) return null;
    return (
      <div
        id={terminalsId}
        // No well: with no sessions there is nothing to contain. The sidebar
        // keeps the well's 1px border, transparent, so the + lands on the same
        // x as the Details chevron above it.
        className={isSidebar ? "mt-1 border border-transparent" : "mt-1.5"}
      >
        <button
          type="button"
          onClick={onStartSession}
          className={cn(
            density.row,
            "min-h-6 gap-1.5 text-2xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
          )}
        >
          <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Start a session</span>
        </button>
      </div>
    );
  }

  // One control open and closed: the chevron, not the row. The count, the
  // agent glyph and the state marks beside it are the card's content and
  // select the worktree like the rest of it (#15864). The same element in
  // both states, so keyboard focus survives the toggle and a click never
  // lands on something that moved.
  const disclosureButton = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-controls={terminalsPanelId}
      aria-label={triggerName}
      aria-describedby={summaryId}
      id={`${terminalsId}-button`}
      data-session-trigger=""
      className={cn(DISCLOSURE_BUTTON, isExpanded && !inline && DISCLOSURE_BUTTON_LABELLED)}
    >
      <ChevronRight
        className={cn("h-3 w-3 shrink-0 text-text-secondary", isExpanded && "rotate-90")}
        aria-hidden="true"
      />
      {/* The open trigger drops the summary glyph in both variants. It led a
          row whose only other leading mark is the chevron, so this section's
          label started ~20px right of Details' — two rows the card presents as
          siblings, sitting on two columns — and it spent that measure on agent
          identity the child rows directly below already carry, one glyph
          each. The closed row keeps it: there, it is the only thing on screen
          naming the agent. */}
      {isExpanded && !inline && (
        <span className={SECTION_LABEL}>Active sessions ({counts.total})</span>
      )}
    </button>
  );
  // The visible count and marks are content rather than part of the control's
  // name, so the breakdown reaches a screen reader as its description.
  const summaryDescription = (
    <span id={summaryId} hidden>
      {collapsedTriggerLabel}
    </span>
  );
  const summaryGlyph = SummaryIcon ? (
    <SummaryIcon className="w-3 h-3 shrink-0" />
  ) : (
    <SquareTerminal className="w-3 h-3 shrink-0" />
  );

  const panel = (
    <SortableContext
      id={`worktree-${worktreeId}-accordion`}
      items={orderedWorktreeTerminals.map((t) => getAccordionDragId(t.id))}
      strategy={verticalListSortingStrategy}
    >
      {eligibleTerminals.length >= 2 && armedIdsSize === 0 && !hintDismissed && (
        <div className="flex items-center justify-between gap-2 border border-transparent py-1 pl-6 pr-2.5 text-2xs text-text-secondary">
          {/* Every click toggles, modifier or not, so the hint names the
              two gestures that exist rather than a Shift variant that does
              the same thing as a plain click. The transparent border is the
              rows' own, so the text starts on their glyph column. */}
          <span>Click or drag to select · Enter opens</span>
          <DismissButton
            className="-my-1 -mr-1.5"
            aria-label="Dismiss hint"
            onClick={(e) => {
              // Dismissing the hint must not double as selecting the
              // card the section happens to live in.
              e.stopPropagation();
              localStorage.setItem(FLEET_HINT_DISMISSED_KEY, "1");
              setHintDismissed(true);
              // The button is about to unmount; focus goes to the first
              // session rather than falling to the document.
              scrollRef.current
                ?.querySelector<HTMLElement>("[data-session-row-button]")
                ?.focus({ preventScroll: true });
            }}
          />
        </div>
      )}
      <div
        id={terminalsPanelId}
        ref={scrollRef}
        role="list"
        data-session-list=""
        // The fleet-arming surface: a marquee drag that ends in here is an
        // arming gesture, never a click on the card.
        data-card-control=""
        aria-labelledby={`${terminalsId}-button`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className={cn(
          "relative max-h-[300px] overflow-y-auto",
          rowClick === "arm" && "cursor-crosshair"
        )}
      >
        {orderedWorktreeTerminals.map((term, index) => (
          <SortableWorktreeTerminal
            key={term.id}
            terminal={term}
            worktreeId={worktreeId}
            sourceIndex={index}
          >
            <TerminalRow
              term={term}
              onClick={handleTerminalClick}
              onOpen={onTerminalSelect}
              padY={density.sessionRowY}
              canArm={rowClick === "arm"}
            />
          </SortableWorktreeTerminal>
        ))}
        {marqueeBox && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 rounded-[var(--radius-md)] border border-border-strong bg-overlay-medium"
            style={{
              left: marqueeBox.x,
              top: marqueeBox.y,
              width: marqueeBox.w,
              height: marqueeBox.h,
            }}
          />
        )}
      </div>
    </SortableContext>
  );

  if (inline) {
    return (
      <>
        <div id={terminalsId} className="mt-1 shrink-0 border border-transparent">
          <div
            // One width whatever its count says, so the age beside it lands on
            // one column down the list.
            className={cn(
              "flex min-h-6 items-center text-xs text-text-secondary",
              density.rowBox,
              "pr-1",
              INLINE_SESSIONS_SLOT
            )}
          >
            {disclosureButton}
            <span aria-hidden="true" className="flex items-center gap-1.5">
              {summaryGlyph}
              {/* One session's count is already beside its state glyph on the
                  title row, so beside the Details row the row names it only
                  past one. Stacked on its own row below 20rem it keeps the
                  count, or it would be a chevron and an icon with nothing to
                  say. */}
              <span
                className={cn(
                  "font-mono tabular-nums",
                  // Only when the title row really carries a glyph for it: a
                  // lone plain shell draws none there.
                  stateGlyphsElsewhere &&
                    counts.total === 1 &&
                    visibleTerminalStates.length > 0 &&
                    "@xs/card:hidden"
                )}
              >
                {counts.total}
              </span>
            </span>
            {summaryDescription}
          </div>
        </div>
        {/* Beneath the shared footer row rather than in place of it: the
            trigger stays where it was clicked. */}
        {isExpanded && (
          <div className={cn(density.well, "w-full @xs/card:basis-full")}>{panel}</div>
        )}
      </>
    );
  }

  return (
    <div id={terminalsId} className={density.well}>
      <div className={cn("flex items-center", density.rowBox)}>
        {disclosureButton}
        {!isExpanded && (
          <>
            <span
              aria-hidden="true"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-2xs text-text-secondary"
            >
              {summaryGlyph}
              <span className="inline-flex items-center gap-1">
                <span className="font-mono tabular-nums">{counts.total}</span>
                <span className="font-sans">active</span>
              </span>
            </span>
            {/* The live sidebar card draws these on its title row, in the
                column where a collapsed card draws them too, so the waiting
                ring sits in the same place on every card in either mode. */}
            {!stateGlyphsElsewhere && visibleTerminalStates.length > 0 && (
              <CollapsedSessionIndicators
                visibleStates={visibleTerminalStates}
                sessionAriaLabel={terminalSessionAriaLabel}
              />
            )}
          </>
        )}
        {summaryDescription}
      </div>
      {isExpanded && panel}
    </div>
  );
}
