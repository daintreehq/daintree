import { useCallback, useMemo, useRef, useState } from "react";
import type React from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { PtyPanelData } from "@shared/types/panel";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { cn } from "@/lib/utils";
import type { WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import { getAgentConfig } from "@/config/agents";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  STATE_LABELS,
  STATE_PRIORITY,
  getEffectiveStateIcon,
  getEffectiveStateColor,
} from "../terminalStateConfig";
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
  X,
} from "lucide-react";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { useKeybindingScope } from "@/hooks/useKeybinding";
import { SECTION_LABEL, CARD_DENSITY } from "./sectionChrome";

interface MarqueeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TerminalRowProps {
  term: PtyPanelData;
  onClick: (term: PtyPanelData) => void;
}

function TerminalRow({ term, onClick }: TerminalRowProps) {
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
  // Only the primary ("last armed") row gets the accent ring — it's the
  // singular focus anchor that will receive keyboard focus when fleet scope
  // exits. Secondary armed peers keep the dashed shape but use a neutral
  // border color so multiple accents never render at once. The arm-position
  // badge stays accent-colored as the secondary signal.
  const isPrimary = useFleetArmingStore((s) => s.lastArmedId === term.id);

  return (
    <div
      data-terminal-id={term.id}
      data-terminal-runtime-kind={chrome.runtimeKind}
      data-terminal-agent-id={chrome.agentId || undefined}
      data-terminal-agent-state={agentState || undefined}
      className={cn(
        "rounded-[var(--radius-md)]",
        isArmed && "outline outline-2 outline-offset-[-2px]",
        isArmed && isPrimary && "outline-solid outline-accent-primary",
        isArmed && !isPrimary && "outline-dashed outline-border-strong"
      )}
    >
      {/* pl-6 puts a session's own glyph under the trigger's glyph and its
          name under the trigger's label. At 18px the children sat 6px LEFT of
          the row that owns them, so two identical rows read as loose peers
          rather than as the contents of the disclosure above them. */}
      <div className="worktree-section-button group/termrow flex items-center justify-between gap-2.5 py-2 pl-6 pr-1 transition-colors">
        <TruncatedTooltip content={term.title} isTruncated={isTruncated}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClick(term);
            }}
            aria-selected={isArmed}
            className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px] rounded-[var(--radius-md)]"
          >
            <div className="shrink-0 opacity-60 group-hover/termrow:opacity-100 transition-opacity">
              <TerminalIcon kind={term.kind} chrome={chrome} className="w-3 h-3" />
            </div>
            <div className="flex flex-col min-w-0">
              <span
                ref={ref}
                className="truncate text-xs font-medium text-text-secondary transition-colors group-hover/termrow:text-text-primary"
              >
                {term.title}
              </span>
              {!chrome.isAgent && term.activityStatus === "working" && term.lastCommand && (
                <Tooltip autoDismiss={false}>
                  <TooltipTrigger asChild>
                    <span className="truncate text-2xs font-mono text-text-muted">
                      {term.lastCommand}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{term.lastCommand}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </button>
        </TruncatedTooltip>

        <div className="flex items-center gap-2.5 shrink-0">
          {isArmed && armBadge !== undefined && (
            <span
              className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent-primary px-1 text-4xs font-mono font-semibold text-accent-primary-foreground tabular-nums"
              aria-label={`Armed position ${armBadge}`}
            >
              {armBadge}
            </span>
          )}

          {(() => {
            const displayAgentState = getTerminalAgentDisplayState(chrome, agentState);
            if (!displayAgentState) return null;
            const Icon = getEffectiveStateIcon(displayAgentState);
            return (
              <Icon
                className={cn(
                  "w-3 h-3",
                  getEffectiveStateColor(displayAgentState),
                  displayAgentState === "working" && "animate-spin-slow motion-reduce:animate-none"
                )}
                aria-label={STATE_LABELS[displayAgentState]}
              />
            );
          })()}

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-text-muted transition-colors group-hover/termrow:text-text-secondary">
                {term.location === "dock" ? (
                  <PanelBottom className="w-3 h-3" />
                ) : (
                  <PanelTopClose className="w-3 h-3" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {term.location === "dock" ? "Docked" : "On grid"}
            </TooltipContent>
          </Tooltip>

          <button
            ref={dragHandle?.setActivatorNodeRef}
            type="button"
            data-drag-handle
            className="flex min-h-6 min-w-6 shrink-0 items-center justify-center cursor-grab rounded-[var(--radius-md)] text-text-muted group-hover/termrow:text-text-secondary transition-colors hover:text-text-secondary focus-visible:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-1 active:cursor-grabbing"
            aria-label="Drag to move terminal"
            {...(dragHandle?.listeners as React.HTMLAttributes<HTMLElement> | undefined)}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
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
}: WorktreeTerminalSectionProps) {
  useKeybindingScope("worktreeGrid", isExpanded);

  const isSidebar = variant === "sidebar";
  const density = CARD_DENSITY[isSidebar ? "sidebar" : "grid"];
  const showMetaFooter = counts.total > 0;

  const terminalsId = `worktree-${worktreeId}-terminals`;
  const terminalsPanelId = `worktree-${worktreeId}-terminals-panel`;

  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem(FLEET_HINT_DISMISSED_KEY) === "1"
  );
  const armedIdsSize = useFleetArmingStore((s) => s.armedIds.size);

  const { visibleTerminalStates, terminalSessionAriaLabel } = useMemo(() => {
    const visible = STATE_PRIORITY.filter((s) => s !== "idle" && counts.byState[s] > 0).map(
      (s) => ({
        state: s,
        count: counts.byState[s],
      })
    );
    const parts = visible.map((v) => `${v.count} ${STATE_LABELS[v.state]}`);
    const label = `${counts.total} session${counts.total !== 1 ? "s" : ""}: ${parts.join(", ")}`;
    return { visibleTerminalStates: visible, terminalSessionAriaLabel: label };
  }, [counts.byState, counts.total]);

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
  const eligibleTerminals = useMemo(
    () => orderedWorktreeTerminals.filter(isFleetArmEligible),
    [orderedWorktreeTerminals]
  );

  const handleTerminalClick = useCallback(
    (term: PtyPanelData) => {
      if (!isFleetArmEligible(term)) {
        onTerminalSelect(term);
        return;
      }
      // Shift, Cmd, Ctrl, and unmodified clicks all toggle membership —
      // the sidebar mirrors the grid's "Shift = single add" gesture so
      // the model is consistent across surfaces.
      useFleetArmingStore.getState().toggleId(term.id);
    },
    [onTerminalSelect]
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
      if (e.button !== 0) return;
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
    [snapshotRects]
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

  /* No sessions. The grid card drops the section — it is a standalone surface
     and ends cleanly on its own border. The sidebar card cannot: the tray IS
     its terminator in a full-bleed list, and a list where only some cards
     carry one separates unevenly, worst at exactly the idle cards that give
     the eye least to hold on to.

     So the row stays, but it does not spend itself saying "No sessions". A
     count of zero is already legible from the empty card above it, and
     repeated down a thirteen-card sidebar it is thirteen rows of nothing. The
     empty-state rule here is to name the next action instead of the absence,
     and the next action on an idle worktree is to start something in it —
     which is also the one thing this row is positioned to offer. Quiet at
     rest, so it reads as a footer and not as a call to action. */
  if (!showMetaFooter) {
    // No tray without somewhere for its row to go: see `onStartSession`.
    //
    // The grid gets it too. It used to render nothing here, which cost the
    // overview twice: a card with no sessions had no bottom slot at all, so
    // its neighbours' bottoms sat 30-50px lower and the row's baseline broke;
    // and "no sessions" and "the sessions row did not render" looked the same.
    // The tray answers both, and it names the next action rather than the
    // absence.
    if (!onStartSession) return null;
    return (
      <div
        id={terminalsId}
        className={
          // The GRID drops the well here. A well is a container, and with no
          // sessions there is nothing to contain — the same "a well around one
          // row is a box around nothing" rule the Details section above
          // already follows. Across 13 cards it was 13 boxes saying the same
          // sentence.
          //
          // The SIDEBAR keeps it, and that is the one place the rule bends:
          // its cards are full-bleed with no border of their own, so this well
          // is also what stops two adjacent cards merging into one another. A
          // grid card has its own border and a 12px gutter and needs no help.
          isSidebar ? density.well : "mt-1.5"
        }
      >
        <button
          type="button"
          onClick={onStartSession}
          className={cn(
            density.row,
            "gap-1.5 text-2xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
          )}
        >
          <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Start a session</span>
        </button>
      </div>
    );
  }

  return (
    <div id={terminalsId} className={density.well}>
      {isExpanded ? (
        <>
          <button
            onClick={onToggle}
            aria-expanded={true}
            aria-controls={terminalsPanelId}
            className={cn(
              // Leading chevron, no fill, no rule under it — the same shape
              // Details uses directly above. The grid used to draw this as a
              // filled header band with a bottom border, which made one
              // disclosure look like a titled sub-panel and the other like a
              // row.
              "transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
              density.row,
              "gap-1.5"
            )}
            id={`${terminalsId}-button`}
          >
            <ChevronRight className="h-3 w-3 shrink-0 rotate-90 text-text-secondary" />
            {/* The expanded trigger drops the summary glyph in both variants.
                It led a row whose only other leading mark is the chevron, so
                this section's label started ~20px right of Details' — two rows
                the card presents as siblings, sitting on two columns — and it
                spent that measure on agent identity the child rows directly
                below already carry, one glyph each. The collapsed trigger
                keeps it: there, it is the only thing on screen naming the
                agent. */}
            <span className={SECTION_LABEL}>Active sessions ({counts.total})</span>
          </button>
          <SortableContext
            id={`worktree-${worktreeId}-accordion`}
            items={orderedWorktreeTerminals.map((t) => getAccordionDragId(t.id))}
            strategy={verticalListSortingStrategy}
          >
            {eligibleTerminals.length >= 2 && armedIdsSize === 0 && !hintDismissed && (
              <div
                className={cn(
                  "flex items-center justify-between px-3 py-1.5 text-2xs text-text-secondary"
                )}
              >
                <span>Drag to select multiple, ⇧-click to add</span>
                <button
                  type="button"
                  className="ml-2 rounded-sm text-text-muted hover:text-text-secondary transition-colors"
                  aria-label="Dismiss hint"
                  onClick={(e) => {
                    // Dismissing the hint must not double as selecting the
                    // card the section happens to live in.
                    e.stopPropagation();
                    localStorage.setItem(FLEET_HINT_DISMISSED_KEY, "1");
                    setHintDismissed(true);
                  }}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            )}
            <div
              id={terminalsPanelId}
              ref={scrollRef}
              role="list"
              aria-labelledby={`${terminalsId}-button`}
              aria-multiselectable="true"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              className={cn("relative max-h-[300px] cursor-crosshair overflow-y-auto")}
            >
              {orderedWorktreeTerminals.map((term, index) => (
                <SortableWorktreeTerminal
                  key={term.id}
                  terminal={term}
                  worktreeId={worktreeId}
                  sourceIndex={index}
                >
                  <TerminalRow term={term} onClick={handleTerminalClick} />
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
        </>
      ) : (
        <button
          onClick={onToggle}
          aria-expanded={false}
          aria-controls={terminalsPanelId}
          className={cn(
            "justify-between transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
            density.row
          )}
          id={`${terminalsId}-button`}
        >
          <div className="flex items-center gap-1.5 text-2xs text-text-secondary">
            <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
            {/* Kept here, unlike the expanded trigger: collapsed, this glyph
                is the ONLY thing on screen saying which agent is running. The
                expanded trigger can drop it because its own child rows are
                directly below it, each carrying that agent's glyph. */}
            {SummaryIcon ? (
              <SummaryIcon className="w-3 h-3" />
            ) : (
              <SquareTerminal className="w-3 h-3" />
            )}
            <span className="inline-flex items-center gap-1">
              <span className="font-mono tabular-nums">{counts.total}</span>
              <span className="font-sans">active</span>
            </span>
          </div>

          {visibleTerminalStates.length > 0 && (
            <CollapsedSessionIndicators
              visibleStates={visibleTerminalStates}
              sessionAriaLabel={terminalSessionAriaLabel}
            />
          )}
        </button>
      )}
    </div>
  );
}
